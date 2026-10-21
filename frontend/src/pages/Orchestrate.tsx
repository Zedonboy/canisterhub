import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Sparkles, ArrowUp, Bot, User, RotateCcw,
  Rocket, ScrollText, Gauge, ShieldCheck, ChevronDown,
} from "lucide-react";
import { clsx } from "clsx";
import { toast } from "@/components/Toast";
import { ACTIVE_PROJECT } from "@/lib/mock-data";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
}

const SUGGESTIONS = [
  { icon: <Rocket size={13} />, label: "Deploy a new Storage canister to production" },
  { icon: <ScrollText size={13} />, label: "Show me error logs from the last hour" },
  { icon: <Gauge size={13} />, label: "How many cycles will I burn this month?" },
  { icon: <ShieldCheck size={13} />, label: "Audit Auth policies for unused roles" },
];

const MODELS = ["claude-opus-4-6", "claude-sonnet-4-6", "gpt-4o"];

/** Still fully simulated - hardcoded keyword matching over `ACTIVE_PROJECT`
 * mock data, no call to the real orchestrator (`POST /orchestrate`) or any
 * canister. Getting a real prompt into this page's input (see the `seed`
 * handling in `Orchestrate`'s own effect below) is real; what happens once
 * it's sent is not, yet. */
function replyFor(command: string, project: typeof ACTIVE_PROJECT): string {
  const c = command.toLowerCase();
  if (c.includes("deploy")) {
    return `On it. Provisioning a new canister on **${project.network}** for "${project.name}"…\n\nCanister ID \`s${Math.random().toString(36).slice(2, 7)}-aaaaa-aaaaa-qhezq-cai\` allocated, WASM installed, and health checks are passing. Deployment complete.`;
  }
  if (c.includes("log")) {
    return "Pulled the last hour of logs across all services. 3 WARN and 1 ERROR entry found — mostly elevated latency on Analytics ingestion. Nothing critical. Want me to open the full log viewer?";
  }
  if (c.includes("cycle") || c.includes("burn") || c.includes("bill")) {
    return `At the current burn rate of ~${(project.burnRatePerDay / 1_000_000_000).toFixed(1)}B cycles/day, you're projected to spend roughly ${((project.burnRatePerDay * 30) / 1_000_000_000).toFixed(0)}B cycles this month. Balance looks healthy for now.`;
  }
  if (c.includes("audit") || c.includes("polic") || c.includes("role")) {
    return "Reviewed Auth policies — found 2 roles with no assigned users (\"beta-tester\", \"legacy-admin\"). I can archive them if you'd like, just say the word.";
  }
  if (c.includes("scale") || c.includes("agent")) {
    return "Agent fleet looks stable — no canister is near its cycle threshold. I can spin up an extra replica of the Support Assistant if traffic keeps climbing.";
  }
  return "Got it — I've queued that up. In a live environment this would call the relevant canister management APIs and report back with the result.";
}

export default function Orchestrate() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [model, setModel] = useState(MODELS[0]);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const location = useLocation();
  const navigate = useNavigate();

  // "use the canister id as A.I prompt in the Orchestrator input" (the
  // user's own framing) - `InstallCanisterDialog` navigates here with a
  // real, already-deployed canister id spliced into `state.seed` right
  // after its own real deploy call succeeds. This part is genuinely wired;
  // the reply this input then gets once sent is still the simulated
  // `replyFor` below - see this file's own module doc note further down.
  useEffect(() => {
    const seed = (location.state as { seed?: string } | null)?.seed;
    if (!seed) return;
    setInput(seed);
    navigate(location.pathname, { replace: true, state: null });
    requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      autoGrow(textareaRef.current);
      textareaRef.current.focus();
    });
    // Runs once, off whatever `state` this route was entered with - not a
    // reactive dependency loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  const send = (text?: string) => {
    const value = (text ?? input).trim();
    if (!value || thinking) return;

    const userMsg: Message = { id: crypto.randomUUID(), role: "user", text: value };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setThinking(true);

    window.setTimeout(() => {
      const reply = replyFor(value, ACTIVE_PROJECT);
      setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: reply }]);
      setThinking(false);
      if (/deploy|scale|archive/i.test(value)) {
        toast.success("Command executed", "Secretary ran the requested action");
      }
    }, 1100 + Math.random() * 700);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  };

  return (
    <div className="flex flex-col h-full animate-fade-in">
      <div className="px-6 pt-4 pb-3 border-b border-[#1e2d47] flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00d4ff22] to-[#c084fc22] border border-[#00d4ff33] flex items-center justify-center">
            <Sparkles size={15} className="text-[#00d4ff]" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-[#e2e8f0] leading-tight">Secretary</h1>
            <p className="text-[11px] text-[#4a5568]">Command your infrastructure in plain English</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              onClick={() => setShowModelPicker((v) => !v)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-mono text-[#8892a4] border border-[#1e2d47] bg-[#0f1629] hover:border-[#00d4ff44] transition-colors"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[#00e676] animate-pulse-dot" />
              {model}
              <ChevronDown size={11} />
            </button>
            {showModelPicker && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowModelPicker(false)} />
                <div className="absolute right-0 top-full mt-1 w-44 bg-[#0f1629] border border-[#1e2d47] rounded-lg shadow-xl z-50 py-1">
                  {MODELS.map((m) => (
                    <button
                      key={m}
                      onClick={() => { setModel(m); setShowModelPicker(false); }}
                      className={clsx(
                        "w-full text-left px-3 py-1.5 text-xs font-mono transition-colors",
                        m === model ? "text-[#00d4ff] bg-[#00d4ff0d]" : "text-[#8892a4] hover:bg-[#131929] hover:text-[#e2e8f0]"
                      )}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            onClick={() => setMessages([])}
            disabled={messages.length === 0}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] text-[#4a5568] hover:text-[#8892a4] hover:bg-[#131929] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <RotateCcw size={12} />
            Clear
          </button>
        </div>
      </div>

      {messages.length === 0 ? (
        <div className="flex-1 overflow-y-auto flex items-center justify-center px-6 py-10">
          <div className="w-full max-w-2xl">
            <div className="rounded-2xl border border-[#1e2d47] bg-[#0d1526] shadow-[0_0_50px_-18px_#00d4ff33] overflow-hidden">
              <div className="px-8 pt-9 pb-6 text-center">
                <h2 className="text-2xl sm:text-[28px] font-bold text-[#e2e8f0] mb-2 tracking-tight">
                  What should Secretary handle?
                </h2>
                <p className="text-sm text-[#8892a4] max-w-lg mx-auto">
                  Describe what you want done in plain English — Secretary will turn it into real actions
                  against <span className="text-[#c8d1e0]">{ACTIVE_PROJECT.name}</span>'s canisters.
                </p>
              </div>

              <div className="px-6">
                <textarea
                  ref={textareaRef}
                  rows={3}
                  value={input}
                  placeholder={'e.g. "Deploy a new Storage canister for user uploads, wire it into the Support agent, and give me the canister id once it\'s live."'}
                  className="w-full min-h-[110px] bg-transparent text-sm text-[#e2e8f0] placeholder-[#4a5568] outline-none resize-none py-2"
                  onChange={(e) => { setInput(e.target.value); autoGrow(e.target); }}
                  onKeyDown={handleKeyDown}
                />
              </div>

              <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-[#1e2d47]">
                <span className="text-[11px] text-[#4a5568]">Enter to run · Shift+Enter for newline</span>
                <button
                  onClick={() => send()}
                  disabled={!input.trim() || thinking}
                  className={clsx(
                    "flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all flex-shrink-0",
                    input.trim() && !thinking
                      ? "bg-[#00d4ff] text-[#0a0e1a] shadow-[0_0_12px_#00d4ff44] hover:bg-[#00b8d9]"
                      : "bg-[#1a2236] text-[#4a5568] cursor-not-allowed"
                  )}
                >
                  <Sparkles size={14} /> Run Command
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2 mt-5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  onClick={() => send(s.label)}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-full border border-[#1e2d47] bg-[#0d1526] hover:border-[#00d4ff44] hover:bg-[#00d4ff08] text-xs text-[#8892a4] hover:text-[#e2e8f0] transition-all"
                >
                  {s.icon} {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto w-full px-6 py-6 space-y-5">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={clsx("flex gap-3 animate-slide-in-up", m.role === "user" && "flex-row-reverse")}
                >
                  <div
                    className={clsx(
                      "w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 border",
                      m.role === "user"
                        ? "bg-[#1a2236] border-[#1e2d47] text-[#8892a4]"
                        : "bg-gradient-to-br from-[#00d4ff22] to-[#c084fc22] border-[#00d4ff33] text-[#00d4ff]"
                    )}
                  >
                    {m.role === "user" ? <User size={13} /> : <Bot size={13} />}
                  </div>
                  <div
                    className={clsx(
                      "max-w-[75%] rounded-xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
                      m.role === "user"
                        ? "bg-[#00d4ff] text-[#0a0e1a] font-medium"
                        : "bg-[#0f1629] border border-[#1e2d47] text-[#c8d1e0]"
                    )}
                  >
                    {m.text}
                  </div>
                </div>
              ))}
              {thinking && (
                <div className="flex gap-3 animate-fade-in">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 border bg-gradient-to-br from-[#00d4ff22] to-[#c084fc22] border-[#00d4ff33] text-[#00d4ff]">
                    <Bot size={13} />
                  </div>
                  <div className="rounded-xl px-4 py-3 bg-[#0f1629] border border-[#1e2d47] flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#4a5568] animate-pulse-dot" />
                    <span className="w-1.5 h-1.5 rounded-full bg-[#4a5568] animate-pulse-dot" style={{ animationDelay: "0.2s" }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-[#4a5568] animate-pulse-dot" style={{ animationDelay: "0.4s" }} />
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="px-6 py-4 border-t border-[#1e2d47] flex-shrink-0">
            <div className="max-w-3xl mx-auto w-full">
              <div className="flex items-end gap-2 px-3 py-2 bg-[#0f1629] border border-[#1e2d47] rounded-2xl focus-within:border-[#00d4ff55] focus-within:shadow-[0_0_0_4px_#00d4ff0d] transition-all">
                <textarea
                  ref={textareaRef}
                  rows={1}
                  value={input}
                  placeholder="Message Secretary — try “deploy a new agent” or “show billing summary”…"
                  className="flex-1 bg-transparent text-sm text-[#e2e8f0] placeholder-[#4a5568] outline-none resize-none py-1.5 max-h-40"
                  onChange={(e) => { setInput(e.target.value); autoGrow(e.target); }}
                  onKeyDown={handleKeyDown}
                />
                <button
                  onClick={() => send()}
                  disabled={!input.trim() || thinking}
                  className={clsx(
                    "w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 transition-all mb-0.5",
                    input.trim() && !thinking
                      ? "bg-[#00d4ff] text-[#0a0e1a] shadow-[0_0_12px_#00d4ff44] hover:bg-[#00b8d9]"
                      : "bg-[#1a2236] text-[#4a5568] cursor-not-allowed"
                  )}
                >
                  <ArrowUp size={15} />
                </button>
              </div>
              <div className="text-center text-[10px] text-[#4a5568] mt-2">
                Enter to send · Shift+Enter for newline · Secretary can make mistakes, verify important actions
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
