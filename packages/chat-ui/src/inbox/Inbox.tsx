import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Bot, LogIn, LogOut, MessagesSquare, RefreshCw, Search } from "lucide-react";
import { clsx } from "clsx";
import { Button } from "@/components/Button";
import { ChannelBadge, ChannelIcon } from "@/components/ChannelBadge";
import { Composer } from "@/components/Composer";
import { MessageList, TypingDots, type BubbleLabels } from "@/components/MessageList";
import { useAuth } from "@/lib/auth";
import {
  CHANNELS,
  getConsoleMessages,
  getMessages,
  listConversations,
  sendOperatorReply,
  sendToAgent,
  type ChannelName,
  type Conversation,
} from "@/lib/chat";
import { timeAgo } from "@/lib/format";
import { usePolling } from "@/lib/usePolling";

/** Selection is mirrored into the URL hash so a thread can be deep-linked
 * and survives reloads: `#console` or `#<Channel>/<session id>`. */
type Selection = { kind: "console" } | { kind: "thread"; channel: ChannelName; sessionId: string };

function parseHash(): Selection | null {
  const h = decodeURIComponent(window.location.hash.slice(1));
  if (h === "console") return { kind: "console" };
  const slash = h.indexOf("/");
  if (slash < 0) return null;
  const channel = h.slice(0, slash) as ChannelName;
  return CHANNELS.includes(channel) ? { kind: "thread", channel, sessionId: h.slice(slash + 1) } : null;
}

function writeHash(s: Selection | null) {
  const next = !s ? "" : s.kind === "console" ? "#console" : `#${s.channel}/${encodeURIComponent(s.sessionId)}`;
  if (window.location.hash !== next) history.replaceState(null, "", next || window.location.pathname + window.location.search);
}

function AuthControl() {
  const { status, principal, delegated, signIn, signOut } = useAuth();
  if (status === "loading") return null;
  if (status === "authenticated") {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[10px] text-c-faint font-mono truncate max-w-[110px]" title={principal ?? undefined}>
          {principal}
        </span>
        {!delegated && (
          <Button variant="ghost" size="sm" onClick={() => signOut().catch(() => undefined)}>
            <LogOut size={13} />
          </Button>
        )}
      </div>
    );
  }
  return (
    <Button variant="secondary" size="sm" onClick={() => signIn().catch(() => undefined)}>
      <LogIn size={13} /> Sign in
    </Button>
  );
}

const LABELS: BubbleLabels = {
  mine: ["operator"],
  names: { customer: "Customer", agent: "Agent", operator: "You" },
};
const CONSOLE_LABELS: BubbleLabels = {
  mine: ["customer"], // in the console the SME's own turns are stored as `User`
  names: { customer: "You", agent: "Agent", operator: "You" },
};

function title(c: Conversation): string {
  return c.displayName || c.sessionId;
}

function ConversationRow({ c, active, onClick }: { c: Conversation; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "w-full text-left px-3 py-2.5 border-b border-c-line/60 flex gap-2.5 transition-colors",
        active ? "bg-c-accent-a11" : "hover:bg-c-surface",
      )}
    >
      <div className="pt-0.5">
        <ChannelIcon channel={c.channel} size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm text-c-text truncate">{title(c)}</span>
          <span className="text-[10px] text-c-faint shrink-0">{timeAgo(c.lastAt)}</span>
        </div>
        <p className="text-xs text-c-muted truncate">
          {c.lastRole === "customer" ? "" : c.lastRole === "operator" ? "You: " : "Agent: "}
          {c.lastText}
        </p>
      </div>
    </button>
  );
}

function Thread({ selection, onBack }: { selection: Selection; onBack: () => void }) {
  const isConsole = selection.kind === "console";
  const key = isConsole ? "console" : `${selection.channel}/${selection.sessionId}`;
  const [awaitingAgent, setAwaitingAgent] = useState(false);

  const { data, error, loading, refresh } = usePolling(
    () => (selection.kind === "console" ? getConsoleMessages() : getMessages(selection.channel, selection.sessionId)),
    3000,
    [key],
  );

  useEffect(() => setAwaitingAgent(false), [key]);

  return (
    <section className="flex-1 min-w-0 flex flex-col">
      <header className="h-12 shrink-0 px-3 border-b border-c-line flex items-center gap-2">
        <Button variant="ghost" size="sm" className="md:hidden" onClick={onBack}>
          <ArrowLeft size={14} />
        </Button>
        {selection.kind === "console" ? (
          <>
            <Bot size={16} className="text-c-accent" />
            <span className="text-sm font-medium">Agent console</span>
            <span className="text-xs text-c-faint hidden sm:inline">private - customers never see this</span>
          </>
        ) : (
          <>
            <ChannelBadge channel={selection.channel} />
            <span className="text-sm font-medium truncate">{selection.sessionId}</span>
          </>
        )}
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void refresh()} title="Refresh">
          <RefreshCw size={13} />
        </Button>
      </header>

      {error && <p className="px-4 py-2 text-xs text-c-danger border-b border-c-danger-a33 break-words">{error}</p>}

      {loading && !data ? (
        <p className="m-auto text-sm text-c-faint">Loading…</p>
      ) : (
        <MessageList
          messages={data ?? []}
          labels={isConsole ? CONSOLE_LABELS : LABELS}
          pending={awaitingAgent ? <TypingDots label="Agent is thinking…" /> : undefined}
          empty={
            <p className="m-auto text-sm text-c-faint text-center max-w-xs">
              {isConsole
                ? "Ask the agent about orders, customers or how it is configured. It answers only you."
                : "No messages in this conversation yet."}
            </p>
          }
        />
      )}

      <Composer
        placeholder={isConsole ? "Message the agent…" : "Reply to customer as yourself (the agent will not answer this)…"}
        actionLabel={isConsole ? "Ask" : "Reply"}
        onSend={async (text) => {
          if (selection.kind === "console") {
            setAwaitingAgent(true);
            try {
              await sendToAgent(text);
            } finally {
              setAwaitingAgent(false);
            }
          } else {
            await sendOperatorReply(selection.channel, selection.sessionId, text);
          }
          await refresh();
        }}
      />
    </section>
  );
}

export default function Inbox() {
  const auth = useAuth();
  const [selection, setSelection] = useState<Selection | null>(parseHash);
  const [filter, setFilter] = useState<ChannelName | "All">("All");
  const [query, setQuery] = useState("");

  const signedIn = auth.status === "authenticated";
  const { data, error, loading, refresh } = usePolling(() => listConversations(), 5000, [auth.principal], auth.status !== "loading");

  useEffect(() => writeHash(selection), [selection]);
  useEffect(() => {
    const onHash = () => setSelection(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data ?? []).filter(
      (c) => (filter === "All" || c.channel === filter) && (!q || `${title(c)} ${c.sessionId} ${c.lastText}`.toLowerCase().includes(q)),
    );
  }, [data, filter, query]);

  const counts = useMemo(() => {
    const m: Record<string, number> = { All: data?.length ?? 0 };
    for (const c of data ?? []) m[c.channel] = (m[c.channel] ?? 0) + 1;
    return m;
  }, [data]);

  const isActive = (c: Conversation) =>
    selection?.kind === "thread" && selection.channel === c.channel && selection.sessionId === c.sessionId;

  return (
    <div className="flex flex-1 min-h-0">
      <aside className={clsx("w-full md:w-80 md:shrink-0 border-r border-c-line flex-col bg-c-bg", selection ? "hidden md:flex" : "flex")}>
        <div className="h-12 shrink-0 px-3 border-b border-c-line flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <MessagesSquare size={16} className="text-c-accent" />
            <span className="text-sm font-semibold">Inbox</span>
          </div>
          <AuthControl />
        </div>

        <div className="p-2 border-b border-c-line flex flex-col gap-2">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-c-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search conversations"
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-c-surface border border-c-line rounded text-c-text placeholder-c-faint focus:outline-none focus:border-c-accent"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {(["All", ...CHANNELS] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={clsx(
                  "px-2 py-1 rounded text-[11px] border transition-colors",
                  filter === f
                    ? "bg-c-accent-a11 text-c-accent border-c-accent-a33"
                    : "text-c-muted border-transparent hover:bg-c-surface hover:text-c-text",
                )}
              >
                {f} {counts[f] ? <span className="opacity-60">{counts[f]}</span> : null}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={() => setSelection({ kind: "console" })}
          className={clsx(
            "px-3 py-2.5 border-b border-c-line flex items-center gap-2.5 text-left transition-colors",
            selection?.kind === "console" ? "bg-c-accent-a11" : "hover:bg-c-surface",
          )}
        >
          <Bot size={16} className="text-c-accent" />
          <div>
            <div className="text-sm text-c-text">Agent console</div>
            <div className="text-xs text-c-muted">Talk to your agent directly</div>
          </div>
        </button>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {error && (
            <div className="p-4 text-xs text-c-danger break-words">
              {signedIn ? error : "Sign in as a controller of this agent to see customer conversations."}
            </div>
          )}
          {loading && !data && !error && <p className="p-4 text-xs text-c-faint">Loading conversations…</p>}
          {data && visible.length === 0 && (
            <p className="p-4 text-xs text-c-faint">{data.length === 0 ? "No customer conversations yet." : "No conversations match."}</p>
          )}
          {visible.map((c) => (
            <ConversationRow
              key={`${c.channel}/${c.sessionId}`}
              c={c}
              active={isActive(c)}
              onClick={() => setSelection({ kind: "thread", channel: c.channel, sessionId: c.sessionId })}
            />
          ))}
        </div>

        <div className="p-2 border-t border-c-line">
          <Button variant="ghost" size="sm" className="w-full" onClick={() => void refresh()}>
            <RefreshCw size={12} /> Refresh
          </Button>
        </div>
      </aside>

      {selection ? (
        <Thread selection={selection} onBack={() => setSelection(null)} />
      ) : (
        <div className="hidden md:flex flex-1 items-center justify-center text-sm text-c-faint">Select a conversation</div>
      )}
    </div>
  );
}
