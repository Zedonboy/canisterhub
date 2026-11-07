import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowUpRight, Bot, Clock3, LogIn, LogOut, MessagesSquare, RefreshCw, Search, ShieldAlert, Ticket as TicketIcon } from "lucide-react";
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
  completeTicket,
  listTickets,
  listConversations,
  sendOperatorReply,
  sendToAgent,
  type ChatMessage,
  type ChannelName,
  type Conversation,
  type Ticket,
} from "@/lib/chat";
import { timeAgo } from "@/lib/format";
import { usePolling } from "@/lib/usePolling";
import { DELEGATION_RECOVERY_EVENT } from "@/lib/delegationRecovery";
import { getDelegationIssue, isEmbedded } from "@/lib/parentDelegation";

/** Selection is mirrored into the URL hash so a thread can be deep-linked
 * and survives reloads: `#console` or `#<Channel>/<session id>`. */
type Selection = { kind: "console" } | { kind: "tickets" } | { kind: "thread"; channel: ChannelName; sessionId: string };
type ChatSelection = Exclude<Selection, { kind: "tickets" }>;

function parseHash(): Selection | null {
  let h = window.location.hash.slice(1);
  if (!h) {
    try { h = localStorage.getItem(routeStorageKey()) ?? ""; } catch { /* storage can be disabled */ }
  }
  try { h = decodeURIComponent(h); } catch { return null; }
  if (h === "console") return { kind: "console" };
  if (h === "tickets") return { kind: "tickets" };
  const slash = h.indexOf("/");
  if (slash < 0) return null;
  const channel = h.slice(0, slash) as ChannelName;
  return CHANNELS.includes(channel) ? { kind: "thread", channel, sessionId: h.slice(slash + 1) } : null;
}

function writeHash(s: Selection | null) {
  const next = !s ? "" : s.kind === "console" ? "#console" : s.kind === "tickets" ? "#tickets" : `#${s.channel}/${encodeURIComponent(s.sessionId)}`;
  try {
    if (s) localStorage.setItem(routeStorageKey(), next.slice(1));
    else localStorage.removeItem(routeStorageKey());
  } catch { /* storage can be disabled */ }
  if (window.location.hash !== next) history.replaceState(null, "", next || window.location.pathname + window.location.search);
}

function routeStorageKey() {
  return `chat-ui:last-route:${window.location.origin}${window.location.pathname}`;
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
  if (isEmbedded()) return null;
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

function ticketStatusLabel(status: Ticket["status"]) {
  return status === "Pending" ? "Open" : status;
}

function TicketsPage({ onBack, onOpenConversation }: { onBack: () => void; onOpenConversation: (ticket: Ticket) => void }) {
  const { data, error, loading, refresh } = usePolling(() => listTickets(), 5000, []);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [completing, setCompleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const selected = data?.find((ticket) => ticket.id === selectedId) ?? data?.[0];
  const pending = (data ?? []).filter((ticket) => ticket.status === "Pending").length;

  useEffect(() => {
    if (selected && selectedId === null) setSelectedId(selected.id);
  }, [selected, selectedId]);

  return (
    <section className="flex-1 min-w-0 flex flex-col">
      <header className="h-12 shrink-0 px-3 border-b border-c-line flex items-center gap-2">
        <Button variant="ghost" size="sm" className="md:hidden" onClick={onBack}><ArrowLeft size={14} /></Button>
        <TicketIcon size={16} className="text-c-accent" />
        <span className="text-sm font-medium">Tickets</span>
        <span className="text-xs text-c-faint">{pending} open</span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void refresh()} title="Refresh"><RefreshCw size={13} /></Button>
      </header>
      {error && <p className="px-4 py-2 text-xs text-c-danger border-b border-c-danger-a33 break-words">{error}</p>}
      {actionError && <p className="px-4 py-2 text-xs text-c-danger border-b border-c-danger-a33 break-words">{actionError}</p>}
      {loading && !data ? <p className="m-auto text-sm text-c-faint">Loading tickets…</p> : !data?.length ? (
        <div className="m-auto flex flex-col items-center gap-2 text-center px-6">
          <TicketIcon size={24} className="text-c-faint" />
          <p className="text-sm text-c-text">No tickets yet</p>
          <p className="text-xs text-c-muted">When the AI asks a human to step in, the ticket will appear here.</p>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 flex-col md:flex-row">
          <div className="w-full md:w-80 md:shrink-0 md:border-r border-c-line overflow-y-auto">
            {data.map((ticket) => (
              <button key={ticket.id} onClick={() => setSelectedId(ticket.id)} className={clsx("w-full text-left p-3 border-b border-c-line/60 transition-colors", selected?.id === ticket.id ? "bg-c-accent-a11" : "hover:bg-c-surface")}>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-c-text truncate flex-1">{ticket.actionType}</span>
                  <span className={clsx("text-[10px] px-1.5 py-0.5 rounded border", ticket.status === "Pending" ? "text-c-accent border-c-accent-a33" : "text-c-muted border-c-line")}>{ticketStatusLabel(ticket.status)}</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-c-faint">
                  <ChannelBadge channel={ticket.channel} />
                  <span className="truncate">{ticket.sessionId}</span>
                  <span className="ml-auto shrink-0">{timeAgo(ticket.createdAt)}</span>
                </div>
                <p className="mt-1 text-xs text-c-muted line-clamp-2">{ticket.details}</p>
              </button>
            ))}
          </div>
          {selected ? (
            <article className="hidden md:flex flex-1 min-w-0 flex-col p-5 gap-4 overflow-y-auto">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-c-faint">Ticket #{selected.id}</p>
                  <h1 className="mt-1 text-lg font-semibold text-c-text">{selected.actionType}</h1>
                </div>
                <span className={clsx("text-xs px-2 py-1 rounded border", selected.status === "Pending" ? "text-c-accent border-c-accent-a33" : "text-c-muted border-c-line")}>{ticketStatusLabel(selected.status)}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-c-muted"><ChannelBadge channel={selected.channel} /><span>{selected.sessionId}</span><span>·</span><Clock3 size={12} /><span>{new Date(selected.createdAt).toLocaleString()}</span></div>
              <div className="rounded-lg border border-c-line bg-c-surface p-4 whitespace-pre-wrap text-sm text-c-text">{selected.details}</div>
              {selected.resultMessage && <div className="rounded-lg border border-c-line p-4 text-sm text-c-muted"><p className="mb-1 text-[10px] uppercase tracking-wide text-c-faint">Customer follow-up</p>{selected.resultMessage}</div>}
              <div className="mt-auto pt-2">
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => onOpenConversation(selected)}>Open customer conversation <ArrowUpRight size={14} /></Button>
                  {selected.status === "Pending" && <Button variant="primary" disabled={completing} onClick={() => {
                    setCompleting(true); setActionError(null);
                    void completeTicket(selected.id).then(() => refresh()).catch((e) => setActionError(e instanceof Error ? e.message : String(e))).finally(() => setCompleting(false));
                  }}>{completing ? "Saving…" : "Mark handled"}</Button>}
                </div>
              </div>
            </article>
          ) : <div className="hidden md:flex flex-1 items-center justify-center text-sm text-c-faint">Select a ticket</div>}
          {selected && <article className="md:hidden border-t border-c-line p-4 flex flex-col gap-3">
            <div><p className="text-xs text-c-faint">Ticket #{selected.id}</p><h1 className="mt-1 text-base font-semibold text-c-text">{selected.actionType}</h1></div>
            <div className="flex items-center gap-2 text-xs text-c-muted"><ChannelBadge channel={selected.channel} /><span className="truncate">{selected.sessionId}</span><span>·</span><span>{timeAgo(selected.createdAt)}</span></div>
            <div className="rounded-lg border border-c-line bg-c-surface p-3 whitespace-pre-wrap text-sm text-c-text">{selected.details}</div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => onOpenConversation(selected)}>Open conversation <ArrowUpRight size={14} /></Button>
              {selected.status === "Pending" && <Button variant="primary" disabled={completing} onClick={() => {
                setCompleting(true); setActionError(null);
                void completeTicket(selected.id).then(() => refresh()).catch((e) => setActionError(e instanceof Error ? e.message : String(e))).finally(() => setCompleting(false));
              }}>{completing ? "Saving…" : "Mark handled"}</Button>}
            </div>
          </article>}
        </div>
      )}
    </section>
  );
}

function Thread({ selection, onBack }: { selection: ChatSelection; onBack: () => void }) {
  const isConsole = selection.kind === "console";
  const key = isConsole ? "console" : `${selection.channel}/${selection.sessionId}`;
  const [awaitingAgent, setAwaitingAgent] = useState(false);
  const [optimisticMessage, setOptimisticMessage] = useState<ChatMessage | null>(null);

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
          messages={[...(data ?? []), ...(optimisticMessage ? [optimisticMessage] : [])]}
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
          setOptimisticMessage({
            index: -1,
            role: isConsole ? "customer" : "operator",
            text,
            at: Date.now(),
          });
          try {
            if (selection.kind === "console") {
              setAwaitingAgent(true);
              await sendToAgent(text);
            } else {
              await sendOperatorReply(selection.channel, selection.sessionId, text);
            }
            await refresh();
          } finally {
            setAwaitingAgent(false);
            setOptimisticMessage(null);
          }
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
  const [delegationExpired, setDelegationExpired] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  const signedIn = auth.status === "authenticated";
  const { data, error, loading, refresh } = usePolling(() => listConversations(), 5000, [auth.principal], auth.status !== "loading");

  useEffect(() => writeHash(selection), [selection]);
  useEffect(() => {
    const onHash = () => setSelection(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    const onDelegationExpired = () => {
      setDelegationExpired(true);
      setReconnectError(null);
    };
    window.addEventListener(DELEGATION_RECOVERY_EVENT, onDelegationExpired);
    return () => window.removeEventListener(DELEGATION_RECOVERY_EVENT, onDelegationExpired);
  }, []);

  const reconnect = async () => {
    setReconnecting(true);
    setReconnectError(null);
    try {
      const identity = await auth.reconnectDelegation();
      if (!identity) throw new Error(getDelegationIssue() ?? "The dashboard could not renew your secure session.");
      setDelegationExpired(false);
    } catch {
      setReconnectError("The dashboard could not renew your secure session. Keep this page open and try again.");
    } finally {
      setReconnecting(false);
    }
  };

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
  const showDelegationRecovery = isEmbedded() && (delegationExpired || !!auth.delegationIssue);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {showDelegationRecovery && (
        <div role="alert" className="shrink-0 px-4 py-3 bg-c-danger-a22 border-b border-c-danger-a44 flex items-start gap-3">
          <ShieldAlert size={18} className="mt-0.5 text-c-danger shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-c-text">
              {delegationExpired ? "Your secure dashboard session expired" : "Could not connect to the dashboard"}
            </p>
            <p className="mt-0.5 text-xs text-c-muted">Reconnect to continue. Your conversations are safe.</p>
            {reconnectError && <p className="mt-1 text-xs text-c-danger">{reconnectError}</p>}
          </div>
          <Button variant="danger" size="sm" disabled={reconnecting} onClick={() => void reconnect()}>
            <RefreshCw size={13} className={reconnecting ? "animate-spin" : ""} />
            {reconnecting ? "Reconnecting…" : "Reconnect"}
          </Button>
        </div>
      )}
      <div className="flex flex-1 min-h-0">
      <aside className={clsx("w-full md:w-80 md:shrink-0 border-r border-c-line flex-col bg-c-bg", selection ? "hidden md:flex" : "flex")}>
        <div className="h-12 shrink-0 px-3 border-b border-c-line flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {selection?.kind === "tickets" ? <TicketIcon size={16} className="text-c-accent" /> : <MessagesSquare size={16} className="text-c-accent" />}
            <span className="text-sm font-semibold">{selection?.kind === "tickets" ? "Tickets" : "Inbox"}</span>
          </div>
          <AuthControl />
        </div>

        <div className="grid grid-cols-2 gap-1 p-2 border-b border-c-line">
          <button onClick={() => setSelection(null)} className={clsx("px-2 py-1.5 rounded text-xs", selection?.kind !== "tickets" ? "bg-c-accent-a11 text-c-accent" : "text-c-muted hover:bg-c-surface")}><MessagesSquare size={12} className="inline mr-1" />Inbox</button>
          <button onClick={() => setSelection({ kind: "tickets" })} className={clsx("px-2 py-1.5 rounded text-xs", selection?.kind === "tickets" ? "bg-c-accent-a11 text-c-accent" : "text-c-muted hover:bg-c-surface")}><TicketIcon size={12} className="inline mr-1" />Tickets</button>
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

      {selection?.kind === "tickets" ? (
        <TicketsPage onBack={() => setSelection(null)} onOpenConversation={(ticket) => setSelection({ kind: "thread", channel: ticket.channel, sessionId: ticket.sessionId })} />
      ) : selection ? (
        <Thread selection={selection} onBack={() => setSelection(null)} />
      ) : (
        <div className="hidden md:flex flex-1 items-center justify-center text-sm text-c-faint">Select a conversation</div>
      )}
      </div>
    </div>
  );
}
