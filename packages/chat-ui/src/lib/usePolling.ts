import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "./format";
import { reportDelegationFailure } from "./delegationRecovery";

/** Re-runs `fetcher` every `intervalMs` (paused while the tab is hidden) and
 * whenever `deps` change. Results from a superseded run are dropped, so a
 * slow reply for conversation A can never overwrite conversation B. */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number, deps: unknown[], enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const mine = generation.current;
    try {
      const next = await fetcherRef.current();
      if (mine !== generation.current) return;
      setData(next);
      setError(null);
    } catch (e) {
      if (mine === generation.current) {
        const delegationExpired = reportDelegationFailure(e);
        setError(delegationExpired
          ? "Your secure dashboard session expired. Reconnect to continue."
          : errorText(e));
      }
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    setData(null);
    setLoading(true);
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, intervalMs);
    return () => {
      generation.current += 1;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, enabled, ...deps]);

  return { data, error, loading, refresh };
}
