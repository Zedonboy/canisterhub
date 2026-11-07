import { useState } from "react";
import { Check, Fingerprint, LoaderCircle, LogOut, MapPin, MessageCircle, Pencil, ShieldCheck } from "lucide-react";
import { Button } from "@/components/Button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Composer } from "@/components/Composer";
import { NotificationNotice } from "@/components/NotificationNotice";
import { MessageList, TypingDots, type BubbleLabels } from "@/components/MessageList";
import {
  webMessages,
  webPendingClientData,
  webSend,
  webSubmitClientData,
  type ChatMessage,
} from "@/lib/chat";
import { errorText } from "@/lib/format";
import { MAX_DISPLAY_NAME, loadDisplayName, saveDisplayName } from "@/lib/displayName";
import { useCustomerAuth } from "@/lib/customerAuth";
import { usePolling } from "@/lib/usePolling";

const LABELS: BubbleLabels = {
  mine: ["customer"],
  names: { customer: "You", agent: "Assistant", operator: "Team" },
};

function Frame({ children, onSignOut }: { children: React.ReactNode; onSignOut?: () => void }) {
  return (
    <div className="flex-1 min-h-0 flex justify-center sm:p-6">
      <main className="w-full max-w-2xl flex flex-col min-h-0 sm:rounded-xl sm:border border-c-line bg-c-bg overflow-hidden">
        <header className="shrink-0 px-4 py-3 border-b border-c-line flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-c-accent-a14 border border-c-accent-a44 flex items-center justify-center">
            <MessageCircle size={17} className="text-c-accent" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold leading-tight">Chat with us</h1>
            <p className="text-xs text-c-muted truncate">Ask a question or place an order - we usually reply in seconds.</p>
          </div>
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <ThemeToggle />
            {onSignOut && (
              <Button variant="ghost" size="sm" onClick={onSignOut} title="Sign out" aria-label="Sign out">
                <LogOut size={14} />
              </Button>
            )}
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}

/** Shown before anyone can chat: the customer proves who they are with
 * Internet Identity (passkey / biometrics, no password, no email). Their
 * principal is their conversation, so they get the same history on every
 * device they sign in from. */
function SignInGate({ onSignIn }: { onSignIn: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Frame>
      <div className="m-auto px-6 py-10 flex flex-col items-center text-center gap-4 max-w-sm">
        <div className="w-14 h-14 rounded-full bg-c-accent-a14 border border-c-accent-a44 flex items-center justify-center">
          <Fingerprint size={26} className="text-c-accent" />
        </div>
        <h2 className="text-lg font-semibold">Sign in to start chatting</h2>
        <p className="text-sm text-c-muted">
          Use Internet Identity - a passkey or your device's biometrics. No password or email needed, and your
          conversation follows you across devices.
        </p>
        <Button
          variant="primary"
          size="lg"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            onSignIn()
              .catch((e) => setError(errorText(e)))
              .finally(() => setBusy(false));
          }}
        >
          <Fingerprint size={16} /> {busy ? "Waiting for Internet Identity…" : "Sign in with Internet Identity"}
        </Button>
        {error && <p className="text-xs text-c-danger break-words">{error}</p>}
      </div>
    </Frame>
  );
}

function Chat({ principal, onSignOut }: { principal: string; onSignOut: () => void }) {
  const [sending, setSending] = useState<string | null>(null);
  const [name, setName] = useState(loadDisplayName);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [sharingLocation, setSharingLocation] = useState(false);
  const [clientDataError, setClientDataError] = useState<string | null>(null);

  // Poll while idle too, so a reply typed by the business owner shows up
  // without the customer doing anything. Faster while a reply is expected.
  const { data, error, loading, refresh } = usePolling(() => webMessages(0), sending ? 2000 : 5000, [principal]);
  const pending = usePolling(() => webPendingClientData(), sending ? 2000 : 5000, [principal]);
  const clientRequest = pending.data;
  const wantsLocation = !!clientRequest && "Location" in clientRequest.kind;

  const messages: ChatMessage[] = [...(data ?? [])];
  if (sending) messages.push({ index: -1, role: "customer", text: sending, at: Date.now() });

  return (
    <Frame onSignOut={onSignOut}>
      <NotificationNotice principal={principal} />
      {error && !data && <p className="px-4 py-2 text-xs text-c-danger break-words">Couldn't load the conversation: {error}</p>}

      {loading && !data ? (
        <p className="m-auto text-sm text-c-faint">Loading…</p>
      ) : (
        <MessageList
          messages={messages}
          labels={LABELS}
          pending={sending ? <TypingDots label="Typing…" /> : undefined}
          empty={<p className="m-auto text-sm text-c-faint text-center max-w-xs">👋 Hi! How can we help you today?</p>}
        />
      )}

      {clientRequest && (
        <div className="shrink-0 mx-3 mb-2 rounded-lg border border-c-accent-a44 bg-c-accent-a11 p-3">
          <p className="text-sm font-medium text-c-text">Information needed</p>
          <p className="mt-1 text-xs text-c-muted">{clientRequest.prompt}</p>
          {wantsLocation && (
            <Button
              className="mt-3"
              variant="primary"
              size="sm"
              disabled={sharingLocation}
              onClick={() => {
                setSharingLocation(true);
                setClientDataError(null);
                navigator.geolocation.getCurrentPosition(
                  ({ coords }) => {
                    setSending("Shared current location");
                    webSubmitClientData(
                      clientRequest.id,
                      { Location: { latitude: coords.latitude, longitude: coords.longitude } },
                      name,
                    )
                      .then(async () => {
                        await Promise.all([refresh(), pending.refresh()]);
                      })
                      .catch((e) => setClientDataError(errorText(e)))
                      .finally(() => {
                        setSending(null);
                        setSharingLocation(false);
                      });
                  },
                  (e) => {
                    setClientDataError(e.message || "Your browser could not share this location.");
                    setSharingLocation(false);
                  },
                  { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
                );
              }}
            >
              {sharingLocation ? <LoaderCircle size={14} className="animate-spin" /> : <MapPin size={14} />}
              {sharingLocation ? "Getting location…" : "Share current location"}
            </Button>
          )}
          {clientDataError && <p className="mt-2 text-xs text-c-danger">{clientDataError}</p>}
        </div>
      )}

      <Composer
        placeholder={clientRequest && !wantsLocation ? clientRequest.prompt : "Type your message…"}
        disabled={loading && !data && !error}
        onSend={async (text) => {
          setSending(text);
          try {
            if (clientRequest && !wantsLocation) {
              await webSubmitClientData(clientRequest.id, { Text: text }, name);
            } else {
              await webSend(text, name);
            }
            await Promise.all([refresh(), pending.refresh()]);
          } finally {
            setSending(null);
          }
        }}
      />
      <div className="shrink-0 px-4 pb-2 text-[10px] text-c-faint flex items-center gap-x-3 gap-y-1 flex-wrap">
        <span className="flex items-center gap-1">
          <ShieldCheck size={10} /> Signed in with Internet Identity · {principal.slice(0, 5)}…{principal.slice(-3)}
        </span>
        {editing ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              setName(saveDisplayName(draft));
              setEditing(false);
            }}
          >
            <input
              autoFocus
              value={draft}
              maxLength={MAX_DISPLAY_NAME}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Your name (optional)"
              aria-label="Your name (optional)"
              className="w-40 px-2 py-0.5 rounded border border-c-line bg-c-surface text-c-text text-[11px] outline-none focus:border-c-accent"
            />
            <button type="submit" aria-label="Save name" className="text-c-accent">
              <Check size={12} />
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraft(name);
              setEditing(true);
            }}
            className="flex items-center gap-1 hover:text-c-text"
          >
            <Pencil size={10} /> {name ? `Chatting as ${name}` : "Add your name (optional)"}
          </button>
        )}
      </div>
    </Frame>
  );
}

export default function WebChat() {
  const auth = useCustomerAuth();

  if (auth.status === "loading") return <p className="m-auto text-sm text-c-faint">Loading…</p>;
  if (auth.status === "anonymous" || !auth.principal) return <SignInGate onSignIn={auth.signIn} />;
  return <Chat principal={auth.principal} onSignOut={() => void auth.signOut()} />;
}
