import { useEffect, useRef } from "react";
import { clsx } from "clsx";
import type { ChatMessage, SenderRole } from "@/lib/chat";
import { clockTime, dayLabel } from "@/lib/format";
import { MessageContent } from "./AutoMedia";

export interface BubbleLabels {
  /** Which role renders on the right-hand ("me") side. */
  mine: SenderRole[];
  names: Record<SenderRole, string>;
}

function Bubble({ m, mine, name }: { m: ChatMessage; mine: boolean; name: string }) {
  const tone =
    m.role === "customer"
      ? "bg-c-surface2 border-c-line text-c-text"
      : m.role === "operator"
        ? "bg-c-op-a22 border-c-op-a55 text-c-text"
        : "bg-c-accent-a14 border-c-accent-a44 text-c-text";
  return (
    <div className={clsx("flex flex-col max-w-[82%]", mine ? "self-end items-end" : "self-start items-start")}>
      <span className="text-[10px] text-c-faint mb-0.5 px-1">
        {name} · {clockTime(m.at)}
      </span>
      <div className={clsx("px-3 py-2 rounded-lg border text-sm break-words [&_pre]:max-w-full", tone)}><MessageContent text={m.text} /></div>
    </div>
  );
}

/** Scrolling transcript with day dividers. Sticks to the bottom only when the
 * reader was already at the bottom, so polling never yanks someone who has
 * scrolled up to re-read an earlier message. */
export function MessageList({
  messages,
  labels,
  pending,
  empty,
}: {
  messages: ChatMessage[];
  labels: BubbleLabels;
  /** Footer row, e.g. a typing indicator. */
  pending?: React.ReactNode;
  empty?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending]);

  let lastDay = "";
  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      className="flex-1 min-h-0 overflow-y-auto px-4 py-4 flex flex-col gap-3"
    >
      {messages.length === 0 && !pending && (empty ?? <p className="m-auto text-sm text-c-faint">No messages yet.</p>)}
      {messages.map((m) => {
        const day = dayLabel(m.at);
        const divider = day !== lastDay;
        lastDay = day;
        return (
          <div key={m.index} className="flex flex-col gap-3">
            {divider && <div className="self-center text-[10px] uppercase tracking-wider text-c-faint">{day}</div>}
            <Bubble m={m} mine={labels.mine.includes(m.role)} name={labels.names[m.role]} />
          </div>
        );
      })}
      {pending}
    </div>
  );
}

export function TypingDots({ label }: { label: string }) {
  return (
    <div className="self-start flex items-center gap-2 text-xs text-c-muted">
      <span className="flex gap-1">
        {[0, 150, 300].map((d) => (
          <span key={d} className="w-1.5 h-1.5 rounded-full bg-c-accent animate-pulse" style={{ animationDelay: `${d}ms` }} />
        ))}
      </span>
      {label}
    </div>
  );
}
