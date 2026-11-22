//! Admission control for channel webhooks (WhatsApp, Telegram).
//!
//! The webhook secret only proves a request came from Meta or Telegram, not
//! that its sender is welcome or that it is new. Every admitted message costs
//! an LLM call, an outbound call and an owner notification, so this module
//! drops duplicates and replays and caps how much any one sender - and the
//! channels as a whole - can spend per day.
//!
//! State is heap-only (reset on upgrade): losing it only briefly re-opens
//! the window, and the WhatsApp timestamp check still bounds replays.

use crate::messages::SessionKey;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};

const SEEN_CAPACITY: usize = 4_096;
const MIN_GAP_NS: u64 = 2_000_000_000;
const DAY_NS: u64 = 86_400_000_000_000;
const MAX_PER_SENDER_PER_DAY: usize = 200;
/// Across all senders on all channels: bounds cycle/LLM spend even when the
/// attacker rotates senders.
const MAX_TOTAL_PER_DAY: usize = 5_000;
const MAX_TRACKED_SENDERS: usize = 10_000;
/// A signed WhatsApp payload older (or further in the future) than this is
/// treated as a replay. Retries of a delivered message are caught by the
/// duplicate check instead.
pub const MAX_WEBHOOK_AGE_SECS: u64 = 600;

#[derive(Debug, PartialEq, Eq)]
pub enum Admission {
    Admit,
    Duplicate,
    RateLimited,
}

#[derive(Default)]
struct State {
    seen: HashSet<String>,
    order: VecDeque<String>,
    sends: HashMap<SessionKey, Vec<u64>>,
    total: Vec<u64>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// Decides whether a channel message may be processed, recording it if so.
/// `dedup_id` identifies the message to the channel (e.g. `tg:42`); `None`
/// skips the duplicate check.
pub fn admit(sender: &SessionKey, dedup_id: Option<&str>, now: u64) -> Admission {
    STATE.with(|s| admit_in(&mut s.borrow_mut(), sender, dedup_id, now))
}

fn admit_in(s: &mut State, sender: &SessionKey, dedup_id: Option<&str>, now: u64) -> Admission {
    if let Some(id) = dedup_id {
        if s.seen.contains(id) {
            return Admission::Duplicate;
        }
    }
    s.total.retain(|t| now.saturating_sub(*t) < DAY_NS);
    if s.total.len() >= MAX_TOTAL_PER_DAY {
        return Admission::RateLimited;
    }
    let times = s.sends.entry(sender.clone()).or_default();
    times.retain(|t| now.saturating_sub(*t) < DAY_NS);
    let too_fast = times
        .last()
        .is_some_and(|last| now.saturating_sub(*last) < MIN_GAP_NS);
    if too_fast || times.len() >= MAX_PER_SENDER_PER_DAY {
        return Admission::RateLimited;
    }
    times.push(now);
    s.total.push(now);
    if s.sends.len() > MAX_TRACKED_SENDERS {
        s.sends
            .retain(|_, t| t.last().is_some_and(|l| now.saturating_sub(*l) < DAY_NS));
    }
    // Only remembered once admitted, so a rate-limited message can be retried
    // by the channel and still get through later.
    if let Some(id) = dedup_id {
        s.seen.insert(id.to_string());
        s.order.push_back(id.to_string());
        while s.order.len() > SEEN_CAPACITY {
            if let Some(old) = s.order.pop_front() {
                s.seen.remove(&old);
            }
        }
    }
    Admission::Admit
}

/// Whether a WhatsApp `timestamp` (unix seconds) is within the replay window
/// of `now_secs`. A missing or unparsable timestamp is accepted: Meta always
/// sends one, and the duplicate check still applies.
pub fn timestamp_is_fresh(timestamp: Option<&str>, now_secs: u64) -> bool {
    let Some(ts) = timestamp.and_then(|t| t.parse::<u64>().ok()) else {
        return true;
    };
    ts.abs_diff(now_secs) <= MAX_WEBHOOK_AGE_SECS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::Channel;

    fn key(id: &str) -> SessionKey {
        SessionKey {
            channel: Channel::Telegram,
            session_id: id.to_string(),
        }
    }

    const S: u64 = 1_000_000_000;

    #[test]
    fn duplicate_ids_are_rejected_but_rate_limited_ones_can_retry() {
        let mut s = State::default();
        assert_eq!(admit_in(&mut s, &key("a"), Some("m1"), 10 * S), Admission::Admit);
        assert_eq!(admit_in(&mut s, &key("a"), Some("m1"), 20 * S), Admission::Duplicate);
        // Too fast: refused and not remembered...
        assert_eq!(admit_in(&mut s, &key("a"), Some("m2"), 10 * S + 1), Admission::RateLimited);
        // ...so the channel's retry later is admitted.
        assert_eq!(admit_in(&mut s, &key("a"), Some("m2"), 30 * S), Admission::Admit);
    }

    #[test]
    fn per_sender_daily_cap_applies_and_resets() {
        let mut s = State::default();
        for i in 0..MAX_PER_SENDER_PER_DAY as u64 {
            assert_eq!(admit_in(&mut s, &key("a"), None, i * 3 * S), Admission::Admit);
        }
        let last = MAX_PER_SENDER_PER_DAY as u64 * 3 * S;
        assert_eq!(admit_in(&mut s, &key("a"), None, last), Admission::RateLimited);
        assert_eq!(admit_in(&mut s, &key("b"), None, last), Admission::Admit);
        assert_eq!(admit_in(&mut s, &key("a"), None, last + DAY_NS), Admission::Admit);
    }

    #[test]
    fn global_cap_stops_sender_rotation() {
        let mut s = State::default();
        for i in 0..MAX_TOTAL_PER_DAY {
            assert_eq!(
                admit_in(&mut s, &key(&i.to_string()), None, S),
                Admission::Admit
            );
        }
        assert_eq!(admit_in(&mut s, &key("new"), None, S), Admission::RateLimited);
    }

    #[test]
    fn seen_cache_is_bounded() {
        let mut s = State::default();
        for i in 0..(SEEN_CAPACITY + 10) {
            admit_in(&mut s, &key(&i.to_string()), Some(&format!("m{i}")), S);
        }
        assert_eq!(s.seen.len(), SEEN_CAPACITY);
    }

    #[test]
    fn stale_or_future_timestamps_are_replays() {
        assert!(timestamp_is_fresh(Some("1000"), 1000));
        assert!(timestamp_is_fresh(Some("700"), 1000));
        assert!(!timestamp_is_fresh(Some("100"), 1000));
        assert!(!timestamp_is_fresh(Some("5000"), 1000));
        assert!(timestamp_is_fresh(None, 1000));
    }
}
