import { useEffect, useState } from "react";
import { useOutletContext, useNavigate } from "react-router-dom";
import { Bot, Settings, ScrollText, Database, Play, Cpu, Plug, TriangleAlert, ArrowRight, Sparkles, Store, Send, Loader2, Workflow, ChevronDown } from "lucide-react";
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { Dialog, DialogHeader, DialogContent, DialogFooter } from "@/components/ui/Dialog";
import { Table, TableHead, TableBody, Th, Tr, Td } from "@/components/ui/Table";
import { StatusDot } from "@/components/StatusDot";
import { CanisterID } from "@/components/CanisterID";
import { InstallCanisterDialog } from "@/components/InstallCanisterDialog";
import type { ProjectContext } from "@/components/layout/AppShell";
import { listConnectorCanisters, getConnectorSummary, type ConnectorSummary } from "@/lib/connectors";
import { getAgentStats, type AgentStats } from "@/lib/actors";
import {
  listAgentCanisters, getAgentConfig, updateAgentConfig, sendTestMessage, getTestConversation,
  type AgentCanister, type ChatTurn,
} from "@/lib/agentCanisters";
import { MOCK_AGENTS, MOCK_LOGS } from "@/lib/mock-data";
import { toast } from "@/components/Toast";
import { clsx } from "clsx";

const MODELS = [
  { id: "m1", name: "claude-opus-4-6", type: "HTTPS Outcall", endpoint: "https://api.anthropic.com/v1", status: "connected" },
  { id: "m2", name: "claude-sonnet-4-6", type: "HTTPS Outcall", endpoint: "https://api.anthropic.com/v1", status: "connected" },
  { id: "m3", name: "llama-3-8b.wasm", type: "On-chain WASM", endpoint: "renrk-eyaaa-aaaaa-aaada-cai", status: "connected" },
  { id: "m4", name: "gpt-4o", type: "HTTPS Outcall", endpoint: "https://api.openai.com/v1", status: "disconnected" },
];

/** Shown instead of the agent list while a project has none yet - matches
 * Connectors/Auth/Storage/Database's own empty-state styling. */
function AgentsEmptyState({ onAskAI, onBrowseMarket }: { onAskAI: () => void; onBrowseMarket: () => void }) {
  return (
    <div className="flex flex-col items-center text-center px-6 py-14 rounded-xl border border-dashed border-[#1e2d47] bg-[#0d1526]">
      <div className="relative mb-5">
        <div className="absolute inset-0 blur-2xl bg-[#00d4ff22] rounded-full" />
        <div className="relative w-14 h-14 rounded-2xl bg-gradient-to-br from-[#00d4ff22] to-[#c084fc22] border border-[#00d4ff33] flex items-center justify-center">
          <Bot size={24} className="text-[#00d4ff]" />
        </div>
      </div>
      <h3 className="text-base font-semibold text-[#e2e8f0] mb-1.5">No agent canister yet</h3>
      <p className="text-sm text-[#4a5568] max-w-md mb-5">
        An agent now includes the WhatsApp, Telegram, and email connector paths plus LLM tool-calling. Deploy one,
        then test and configure the whole module from its card.
      </p>
      <div className="flex items-center gap-2.5">
        <span className="inline-flex items-center px-3 py-1.5 rounded-full border border-[#1e2d47] bg-[#131929] text-xs text-[#8892a4]">Coming soon</span>
        {/* Marketplace install dialog disabled for production launch (no funds yet) - see TODO.md
        <Button variant="primary" size="sm" className="gap-1.5" onClick={onBrowseMarket}>
          <Store size={14} /> Browse Market
        </Button>
        */}
        {/* Ask AI disabled for production launch (no funds yet) - see TODO.md
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onAskAI}>
          <Sparkles size={14} /> Ask AI to Add an Agent
        </Button>
        */}
      </div>
    </div>
  );
}

/** "when user clicks Test, it opens a Dialog box for text input" (the
 * user's own framing) - a real chat with this specific agent canister via
 * `receive_message`/`get_conversation` (see `lib/agentCanisters.ts`'s own
 * doc comment for the full real flow, including the two genuinely
 * different failure modes it tells apart). Always the same fixed test
 * session, so re-opening Test on the same canister continues the same
 * conversation rather than starting fresh every time. */
function TestDialog({ agent, network, onClose }: { agent: AgentCanister | null; network: string; onClose: () => void }) {
  const [turns, setTurns] = useState<ChatTurn[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!agent) return;
    setTurns(null);
    setLoadError(null);
    setInput("");
    getTestConversation(agent.id, network)
      .then(setTurns)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [agent, network]);

  if (!agent) return null;

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setSending(true);
    try {
      const updated = await sendTestMessage(agent.id, network, text);
      setTurns(updated);
      setInput("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("Test message failed", msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open onClose={() => !sending && onClose()} className="max-w-xl">
      <DialogHeader title={`Test ${agent.name}`} onClose={sending ? undefined : onClose} />
      <DialogContent className="space-y-3">
        {loadError && <p className="text-sm text-[#ff5252]">Couldn't load this conversation: {loadError}</p>}
        <div className="h-72 overflow-y-auto rounded border border-[#1e2d47] bg-[#0a0e1a] p-3 space-y-2">
          {turns === null && !loadError && <p className="text-sm text-[#4a5568]">Loading…</p>}
          {turns !== null && turns.length === 0 && (
            <p className="text-sm text-[#4a5568]">No messages yet - say something below to start a real conversation with this agent.</p>
          )}
          {turns?.map((t, i) => (
            <div
              key={i}
              className={clsx(
                "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                t.role === "user" ? "ml-auto bg-[#00d4ff1a] text-[#e2e8f0]" : "bg-[#1a2236] text-[#e2e8f0]"
              )}
            >
              <div className="text-[10px] text-[#4a5568] mb-0.5">{t.role === "user" ? "You" : agent.name}</div>
              {t.content}
            </div>
          ))}
          {sending && (
            <div className="text-xs text-[#4a5568] flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" /> Thinking - this is a real LLM call, it can take a few seconds…
            </div>
          )}
        </div>
      </DialogContent>
      <DialogFooter>
        <div className="flex items-center gap-2 w-full">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message…"
            disabled={sending}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            className="flex-1"
          />
          <Button variant="primary" size="sm" onClick={send} disabled={sending || !input.trim()} className="gap-1.5 flex-shrink-0">
            {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Send
          </Button>
        </div>
      </DialogFooter>
    </Dialog>
  );
}

const LLM_PROVIDERS = [
  { value: "managed_ic_llm", label: "Managed platform — IC LLM" },
  { value: "managed_deepseek", label: "Managed platform — DeepSeek" },
  { value: "anthropic", label: "Own API key — Claude" },
  { value: "deepseek", label: "Own API key — DeepSeek" },
  { value: "openai", label: "Own API key — OpenAI" },
] as const;

function ConfigGroup({ title, description, children, open = false }: { title: string; description: string; children: React.ReactNode; open?: boolean }) {
  const [isOpen, setIsOpen] = useState(open);

  return (
    <details
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
      className="group rounded-md border border-[#1e2d47] bg-[#0a0e1a55]"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 marker:hidden [&::-webkit-details-marker]:hidden">
        <div>
          <h4 className="text-xs font-medium text-[#e2e8f0]">{title}</h4>
          <p className="mt-0.5 text-[10px] leading-relaxed text-[#4a5568]">{description}</p>
        </div>
        <ChevronDown size={14} className="flex-shrink-0 text-[#4a5568] transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-4 border-t border-[#1e2d47] p-3">{children}</div>
    </details>
  );
}

function WriteOnlySecret({ id, label, value, clear, onValue, onClear }: { id: string; label: string; value: string; clear: boolean; onValue: (value: string) => void; onClear: (clear: boolean) => void }) {
  return (
    <div>
      <Label htmlFor={id}>{label} (write-only)</Label>
      <Input
        id={id}
        type="password"
        placeholder={clear ? "will be cleared" : "leave blank to keep the current value"}
        value={value}
        disabled={clear}
        onChange={(event) => onValue(event.target.value)}
        className="font-mono text-xs"
      />
      <label className="mt-1 flex items-center gap-1.5 text-[11px] text-[#4a5568]">
        <input type="checkbox" checked={clear} onChange={(event) => { onClear(event.target.checked); if (event.target.checked) onValue(""); }} />
        Clear the configured value
      </label>
    </div>
  );
}

/** "the config is a dialog for user to edit config especially Model...
 * edit Agent Instruction" (the user's own framing) - every field here is a
 * real field on the real `Config` (see `packages/agent/agent.did`). */
function ConfigDialog({ agent, network, onClose, onSaved }: { agent: AgentCanister | null; network: string; onClose: () => void; onSaved: () => void }) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [systemPrompt, setSystemPrompt] = useState("");
  const [llmProvider, setLlmProvider] = useState<string>("managed_ic_llm");
  const [llmModel, setLlmModel] = useState("");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [maxToolIterations, setMaxToolIterations] = useState("");
  const [adminWebhookUrl, setAdminWebhookUrl] = useState("");
  const [adminWebhookSecret, setAdminWebhookSecret] = useState("");
  const [clearWebhookSecret, setClearWebhookSecret] = useState(false);
  const [whatsappPhoneNumberId, setWhatsappPhoneNumberId] = useState("");
  const [whatsappVerifyToken, setWhatsappVerifyToken] = useState("");
  const [clearWhatsappVerifyToken, setClearWhatsappVerifyToken] = useState(false);
  const [whatsappAppSecret, setWhatsappAppSecret] = useState("");
  const [clearWhatsappAppSecret, setClearWhatsappAppSecret] = useState(false);
  const [whatsappAccessToken, setWhatsappAccessToken] = useState("");
  const [clearWhatsappAccessToken, setClearWhatsappAccessToken] = useState(false);

  useEffect(() => {
    if (!agent) return;
    setLoading(true);
    setLoadError(null);
    setLlmApiKey("");
    setClearApiKey(false);
    setAdminWebhookSecret("");
    setClearWebhookSecret(false);
    setWhatsappVerifyToken("");
    setClearWhatsappVerifyToken(false);
    setWhatsappAppSecret("");
    setClearWhatsappAppSecret(false);
    setWhatsappAccessToken("");
    setClearWhatsappAccessToken(false);
    getAgentConfig(agent.id, network)
      .then((c) => {
        setSystemPrompt(c.systemPrompt ?? "");
        setLlmProvider(c.llmProvider === "platform" ? "managed_ic_llm" : (c.llmProvider ?? "managed_ic_llm"));
        setLlmModel(c.llmModel ?? "");
        setMaxToolIterations(c.maxToolIterations !== null ? String(c.maxToolIterations) : "");
        setAdminWebhookUrl(c.adminWebhookUrl ?? "");
        setWhatsappPhoneNumberId(c.whatsappPhoneNumberId ?? "");
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [agent, network]);

  if (!agent) return null;

  const save = async () => {
    setSaving(true);
    try {
      await updateAgentConfig(agent.id, network, {
        adminWebhookUrl,
        systemPrompt,
        llmProvider,
        llmModel,
        maxToolIterations,
        llmApiKey: clearApiKey ? "" : llmApiKey.trim() === "" ? undefined : llmApiKey,
        adminWebhookSecret: clearWebhookSecret ? "" : adminWebhookSecret.trim() === "" ? undefined : adminWebhookSecret,
        whatsappPhoneNumberId,
        whatsappVerifyToken: clearWhatsappVerifyToken ? "" : whatsappVerifyToken.trim() === "" ? undefined : whatsappVerifyToken,
        whatsappAppSecret: clearWhatsappAppSecret ? "" : whatsappAppSecret.trim() === "" ? undefined : whatsappAppSecret,
        whatsappAccessToken: clearWhatsappAccessToken ? "" : whatsappAccessToken.trim() === "" ? undefined : whatsappAccessToken,
      });
      toast.success("Config saved", `${agent.name}'s configuration was updated.`);
      onSaved();
      onClose();
    } catch (e) {
      toast.error("Couldn't save config", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const selectClass =
    "w-full px-3 py-2 text-sm bg-[#0a0e1a] border border-[#1e2d47] rounded text-[#e2e8f0] focus:outline-none focus:border-[#00d4ff] focus:ring-1 focus:ring-[#00d4ff33] transition-colors";

  return (
    <Dialog open onClose={() => !saving && onClose()} className="max-w-lg">
      <DialogHeader title={`Configure ${agent.name}`} onClose={saving ? undefined : onClose} />
      <DialogContent className="space-y-4 max-h-[70vh] overflow-y-auto">
        {loading && <p className="text-sm text-[#4a5568]">Loading current config…</p>}
        {loadError && <p className="text-sm text-[#ff5252]">Couldn't load current config: {loadError}</p>}
        {!loading && !loadError && (
          <>
            <ConfigGroup title="Agent Behavior" description="Define how the agent speaks, what it may do, and when it should escalate." open>
              <div>
                <Label htmlFor="agent-instruction">Agent Instruction (system prompt)</Label>
                <textarea
                  id="agent-instruction"
                  rows={4}
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="e.g. You are a support assistant for Acme. Be concise, and never promise a refund yourself - escalate with request_admin_action instead."
                  className={clsx(selectClass, "resize-y placeholder-[#4a5568]")}
                />
                <p className="text-[11px] text-[#4a5568] mt-1">Blank uses this template's generic fallback prompt.</p>
              </div>
            </ConfigGroup>

            <ConfigGroup title="AI Model" description="Choose the model provider, credentials, and maximum tool-calling budget.">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="agent-provider">LLM provider</Label>
                  <select id="agent-provider" value={llmProvider} onChange={(e) => setLlmProvider(e.target.value)} className={selectClass}>
                    {LLM_PROVIDERS.map((provider) => (
                      <option key={provider.value} value={provider.value}>{provider.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="agent-model">Model id (optional)</Label>
                  <Input id="agent-model" placeholder="provider's flagship model" value={llmModel} onChange={(e) => setLlmModel(e.target.value)} className="text-xs" />
                </div>
              </div>

              {llmProvider.startsWith("managed_") ? (
                <p className="text-[11px] text-[#4a5568] bg-[#00d4ff0a] border border-[#00d4ff22] rounded px-3 py-2">
                  This model is called through CanisterHub's backend and charged against the SME owner's token credits.
                  No provider API key is stored in this agent.
                </p>
              ) : (
                <WriteOnlySecret id="agent-api-key" label="API key" value={llmApiKey} clear={clearApiKey} onValue={setLlmApiKey} onClear={setClearApiKey} />
              )}

              <div>
                <Label htmlFor="agent-max-iter">Max tool iterations (optional, 0-255)</Label>
                <Input id="agent-max-iter" placeholder="default" value={maxToolIterations} onChange={(e) => setMaxToolIterations(e.target.value)} className="text-xs" />
              </div>
            </ConfigGroup>

            <ConfigGroup title="WhatsApp" description="Credentials from Meta's WhatsApp Business setup. Secret values are write-only and are never shown back in the dashboard.">
              <div>
                <Label htmlFor="agent-whatsapp-phone">Phone number ID (optional)</Label>
                <Input id="agent-whatsapp-phone" placeholder="Meta phone number ID" value={whatsappPhoneNumberId} onChange={(e) => setWhatsappPhoneNumberId(e.target.value)} className="font-mono text-xs" />
              </div>
              <WriteOnlySecret id="agent-whatsapp-verify" label="Webhook verify token" value={whatsappVerifyToken} clear={clearWhatsappVerifyToken} onValue={setWhatsappVerifyToken} onClear={setClearWhatsappVerifyToken} />
              <WriteOnlySecret id="agent-whatsapp-secret" label="App secret" value={whatsappAppSecret} clear={clearWhatsappAppSecret} onValue={setWhatsappAppSecret} onClear={setClearWhatsappAppSecret} />
              <WriteOnlySecret id="agent-whatsapp-access" label="Access token" value={whatsappAccessToken} clear={clearWhatsappAccessToken} onValue={setWhatsappAccessToken} onClear={setClearWhatsappAccessToken} />
            </ConfigGroup>

            <ConfigGroup title="Administrative Escalation" description="Send actions requiring human approval to the SME's administrative system.">
              <div>
                <Label htmlFor="agent-webhook-url">Admin webhook URL (optional)</Label>
                <Input id="agent-webhook-url" placeholder="https://…" value={adminWebhookUrl} onChange={(e) => setAdminWebhookUrl(e.target.value)} className="text-xs" />
              </div>
              <WriteOnlySecret id="agent-webhook-secret" label="Admin webhook secret" value={adminWebhookSecret} clear={clearWebhookSecret} onValue={setAdminWebhookSecret} onClear={setClearWebhookSecret} />
            </ConfigGroup>
          </>
        )}
      </DialogContent>
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={save} disabled={saving || loading || !!loadError} className="gap-1.5">
          {saving && <Loader2 size={13} className="animate-spin" />} {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

interface AgentSummary {
  name: string;
  id: string;
  stats: AgentStats | null;
  statsError: string | null;
}

function initials(name: string) {
  return name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

/** One agent canister's card - same avatar/stat-row/action-row layout the
 * old "A.I Staff" page's `StaffCard` used, wired to this tab's real data
 * (`get_stats`) instead of that page's mock roster. The bottom-right status
 * dot stands in for `StaffCard`'s availability dot: green once `get_stats`
 * has actually answered, amber if it errored, gray while still loading -
 * there's no real online/offline signal for an agent canister to show. */
function AgentCard({ agent, onTest, onConfig }: { agent: AgentSummary; onTest: () => void; onConfig: () => void }) {
  return (
    <Card className="hover:border-[#00d4ff33] transition-colors">
      <CardContent className="p-4 space-y-4">
        <div className="flex items-start gap-3">
          <div className="relative w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 bg-gradient-to-br from-[#00d4ff33] to-[#00d4ff08] border border-[#1e2d47] text-[#e2e8f0] font-semibold text-sm">
            {initials(agent.name)}
            <span
              className={clsx(
                "absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#0f1629]",
                agent.statsError ? "bg-[#ffab40]" : agent.stats ? "bg-[#00e676]" : "bg-[#4a5568]"
              )}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-[#e2e8f0] truncate">{agent.name}</div>
            <div className="flex items-center gap-1.5 text-[11px] text-[#8892a4]">
              <Bot size={12} />
              <span className="truncate">Agent canister</span>
            </div>
          </div>
          {agent.statsError && (
            <span title={`Couldn't read stats: ${agent.statsError}`} className="flex-shrink-0">
              <TriangleAlert size={14} className="text-[#ffab40]" />
            </span>
          )}
        </div>

        <div className="space-y-1 text-xs pt-1 border-t border-[#162035]">
          <div className="flex justify-between items-center pt-2">
            <span className="text-[#4a5568]">Canister</span>
            <CanisterID id={agent.id} />
          </div>
          <div className="flex justify-between">
            <span className="text-[#4a5568]">Messages in / out</span>
            <span className="text-[#e2e8f0] font-mono">
              {agent.stats ? `${agent.stats.messages_in.toLocaleString()} / ${agent.stats.messages_out.toLocaleString()}` : "…"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[#4a5568]">Tokens used</span>
            <span className="text-[#e2e8f0] font-mono">
              {agent.stats ? (agent.stats.prompt_tokens + agent.stats.completion_tokens).toLocaleString() : "…"}
            </span>
          </div>
        </div>

        <div className="flex gap-1.5 pt-1">
          <Button variant="primary" size="sm" className="flex-1 justify-center gap-1.5" onClick={onTest}>
            <Play size={11} /> Test
          </Button>
          <Button variant="ghost" size="sm" className="justify-center" onClick={onConfig}>
            <Settings size={12} />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Real `agent`-kind canisters on this project (see `lib/agentCanisters.ts`)
 * - each card's stats come from the real, ungated `get_stats`. "Test" and
 * "Config" open the two real dialogs above. */
function AgentsTab() {
  const { job } = useOutletContext<ProjectContext>();
  const navigate = useNavigate();
  const [summaries, setSummaries] = useState<AgentSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [showInstallDialog, setShowInstallDialog] = useState(false);
  const [testTarget, setTestTarget] = useState<AgentCanister | null>(null);
  const [configTarget, setConfigTarget] = useState<AgentCanister | null>(null);

  const agents = job ? listAgentCanisters(job) : [];

  useEffect(() => {
    if (!job) return;
    const targets = listAgentCanisters(job);
    if (targets.length === 0) {
      setSummaries([]);
      return;
    }
    setLoading(true);
    Promise.all(
      targets.map(async (a): Promise<AgentSummary> => {
        try {
          const stats = await getAgentStats(a.id, job.network);
          return { name: a.name, id: a.id, stats, statsError: null };
        } catch (e) {
          return { name: a.name, id: a.id, stats: null, statsError: e instanceof Error ? e.message : String(e) };
        }
      })
    )
      .then(setSummaries)
      .finally(() => setLoading(false));
  }, [job]);

  if (!job) {
    return <div className="p-4 text-sm text-[#4a5568]">Loading…</div>;
  }

  if (agents.length === 0) {
    return (
      <div className="p-4">
        <AgentsEmptyState onAskAI={() => navigate(`/project/${job.id}/orchestrate`)} onBrowseMarket={() => setShowInstallDialog(true)} />
        <InstallCanisterDialog
          open={showInstallDialog}
          onClose={() => setShowInstallDialog(false)}
          jobId={job.id}
          network={job.network}
          onDeployed={() => setSummaries(null)}
          initialQuery="agent"
        />
      </div>
    );
  }

  const rows: AgentSummary[] = summaries ?? agents.map((a) => ({ name: a.name, id: a.id, stats: null, statsError: null }));

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-[#8892a4]">{agents.length} agent{agents.length !== 1 ? "s" : ""} deployed</span>
        {/* Ask AI disabled for production launch (no funds yet) - see TODO.md
        <Button variant="primary" size="sm" onClick={() => navigate(`/project/${job.id}/orchestrate`)} className="gap-1.5">
          <Sparkles size={13} /> Ask AI to Add an Agent
        </Button>
        */}
      </div>
      {loading && summaries === null && <p className="text-sm text-[#4a5568]">Loading…</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {rows.map((a) => (
          <AgentCard
            key={a.id}
            agent={a}
            onTest={() => setTestTarget({ name: a.name, id: a.id })}
            onConfig={() => setConfigTarget({ name: a.name, id: a.id })}
          />
        ))}
      </div>

      <TestDialog agent={testTarget} network={job.network} onClose={() => setTestTarget(null)} />
      <ConfigDialog agent={configTarget} network={job.network} onClose={() => setConfigTarget(null)} onSaved={() => setSummaries(null)} />
      <InstallCanisterDialog
        open={showInstallDialog}
        onClose={() => setShowInstallDialog(false)}
        jobId={job.id}
        network={job.network}
        onDeployed={() => setSummaries(null)}
        initialQuery="agent"
      />
    </div>
  );
}

function ModelsTab() {
  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-[#8892a4]">{MODELS.length} model backends</span>
        <Button variant="primary" size="sm" onClick={() => toast.info("Add model", "Configure API endpoint")}>
          + Add Model
        </Button>
      </div>
      <Table>
        <TableHead>
          <tr>
            <Th>Model Name</Th>
            <Th>Type</Th>
            <Th>Endpoint</Th>
            <Th>Status</Th>
            <Th></Th>
          </tr>
        </TableHead>
        <TableBody>
          {MODELS.map((m) => (
            <Tr key={m.id}>
              <Td className="font-mono font-medium text-[#e2e8f0]">{m.name}</Td>
              <Td><Badge variant={m.type === "On-chain WASM" ? "cyan" : "green"}>{m.type}</Badge></Td>
              <Td className="font-mono text-xs text-[#4a5568] max-w-[180px] truncate">{m.endpoint}</Td>
              <Td>
                <StatusDot
                  status={m.status === "connected" ? "healthy" : "error"}
                  showLabel
                />
              </Td>
              <Td>
                <Button variant="ghost" size="sm">Configure</Button>
              </Td>
            </Tr>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function MemoryTab() {
  return (
    <div className="p-4 space-y-4">
      {MOCK_AGENTS.map((agent) => (
        <Card key={agent.name}>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Bot size={14} className="text-[#00d4ff]" />
              <CardTitle>{agent.name}</CardTitle>
            </div>
            <div className="flex gap-1.5">
              <Button variant="ghost" size="sm">Browse</Button>
              <Button variant="danger" size="sm" onClick={() => toast.warning("Memory cleared", agent.name)}>
                Clear Memory
              </Button>
            </div>
          </CardHeader>
          <CardContent className="text-xs text-[#8892a4]">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-[#0a0e1a] rounded p-3 border border-[#162035]">
                <div className="text-[#e2e8f0] font-bold text-lg font-mono">
                  {Math.floor(Math.random() * 1000 + 100)}
                </div>
                <div className="text-[#4a5568]">Embeddings stored</div>
              </div>
              <div className="bg-[#0a0e1a] rounded p-3 border border-[#162035]">
                <div className="text-[#e2e8f0] font-bold text-lg font-mono">
                  {Math.floor(Math.random() * 50 + 5)}
                </div>
                <div className="text-[#4a5568]">KV entries</div>
              </div>
              <div className="bg-[#0a0e1a] rounded p-3 border border-[#162035]">
                <div className="text-[#e2e8f0] font-bold text-lg font-mono">
                  {Math.floor(Math.random() * 10 + 1)} MB
                </div>
                <div className="text-[#4a5568]">Memory used</div>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function AgentLogsTab() {
  const agentLogs = MOCK_LOGS.filter((l) => l.service === "AGENTS");

  return (
    <div className="p-4">
      <div className="font-mono text-xs space-y-0.5">
        {agentLogs.map((log) => (
          <div key={log.timestamp + log.message} className="flex gap-2 py-1.5 px-3 hover:bg-[#131929] rounded transition-colors">
            <span className="text-[#4a5568] flex-shrink-0">{log.timestamp.replace("T", " ").replace("Z", "")}</span>
            <span className={clsx("flex-shrink-0",
              log.level === "ERROR" ? "text-[#ff5252]" :
              log.level === "WARN" ? "text-[#ffab40]" :
              "text-[#00d4ff]"
            )}>[{log.level}]</span>
            <span className="text-[#8892a4]">{log.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Shown instead of the connector list while a project has none yet -
 * matches Auth/Storage/Database's own empty-state styling. */
function ConnectorsEmptyState({ onAskAI, onBrowseMarket }: { onAskAI: () => void; onBrowseMarket: () => void }) {
  return (
    <div className="flex flex-col items-center text-center px-6 py-14 rounded-xl border border-dashed border-[#1e2d47] bg-[#0d1526]">
      <div className="relative mb-5">
        <div className="absolute inset-0 blur-2xl bg-[#00d4ff22] rounded-full" />
        <div className="relative w-14 h-14 rounded-2xl bg-gradient-to-br from-[#00d4ff22] to-[#c084fc22] border border-[#00d4ff33] flex items-center justify-center">
          <Plug size={24} className="text-[#00d4ff]" />
        </div>
      </div>
      <h3 className="text-base font-semibold text-[#e2e8f0] mb-1.5">No connector canister yet</h3>
      <p className="text-sm text-[#4a5568] max-w-md mb-5">
        A connector receives messages from the outside world (WhatsApp, Telegram, email) and forwards them to
        an agent canister here - deploy one to wire real conversations into this project's agents.
      </p>
      <div className="flex items-center gap-2.5">
        <span className="inline-flex items-center px-3 py-1.5 rounded-full border border-[#1e2d47] bg-[#131929] text-xs text-[#8892a4]">Coming soon</span>
        {/* Marketplace install dialog disabled for production launch (no funds yet) - see TODO.md
        <Button variant="primary" size="sm" className="gap-1.5" onClick={onBrowseMarket}>
          <Store size={14} /> Browse Market
        </Button>
        */}
        {/* Ask AI disabled for production launch (no funds yet) - see TODO.md
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onAskAI}>
          <Sparkles size={14} /> Ask AI to Add a Connector
        </Button>
        */}
      </div>
    </div>
  );
}

/** "create a Tab for Connectors" (the user's own framing) - real
 * `connector`-kind canisters on this project (see `lib/connectors.ts`),
 * each showing its real message-processed count (`get_stats`, open to any
 * caller) and which agent canister it forwards to (`get_config`,
 * controller-only - resolved against this same project's own `agent`-kind
 * canisters when it matches one, since that's the whole reason this tab
 * lives on the Agent page). A config-read failure (most commonly: not a
 * controller of that specific canister) shows a caution icon rather than
 * inline error text - same convention `Wallet.tsx`'s own token rows use. */
function ConnectorsTab() {
  const { job } = useOutletContext<ProjectContext>();
  const navigate = useNavigate();
  const [summaries, setSummaries] = useState<ConnectorSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [showInstallDialog, setShowInstallDialog] = useState(false);

  const connectors = job ? listConnectorCanisters(job) : [];
  // Every real `agent`-kind canister on this project, by id - lets a
  // connector's own `agent_canister` principal resolve to a friendly
  // project-local name instead of just a bare principal.
  const agentNameById = new Map(
    job ? Object.entries(job.canisters).filter(([, info]) => info.kind === "agent").map(([name, info]) => [info.id, name]) : []
  );

  useEffect(() => {
    if (!job) return;
    const targets = listConnectorCanisters(job);
    if (targets.length === 0) {
      setSummaries([]);
      return;
    }
    setLoading(true);
    Promise.all(targets.map((c) => getConnectorSummary(c.name, c.id, job.network)))
      .then(setSummaries)
      .finally(() => setLoading(false));
  }, [job]);

  if (!job) {
    return <div className="p-4 text-sm text-[#4a5568]">Loading…</div>;
  }

  if (connectors.length === 0) {
    return (
      <div className="p-4">
        <ConnectorsEmptyState onAskAI={() => navigate(`/project/${job.id}/orchestrate`)} onBrowseMarket={() => setShowInstallDialog(true)} />
        <InstallCanisterDialog
          open={showInstallDialog}
          onClose={() => setShowInstallDialog(false)}
          jobId={job.id}
          network={job.network}
          onDeployed={() => setSummaries(null)}
          initialQuery="connector"
        />
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      <span className="text-sm text-[#8892a4]">{connectors.length} connector{connectors.length !== 1 ? "s" : ""} deployed</span>
      {loading && summaries === null && <p className="text-sm text-[#4a5568]">Loading…</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {(summaries ?? connectors.map((c) => ({ name: c.name, id: c.id, messagesProcessed: null, agentCanister: null, authorizedSender: null, configError: null }))).map((c) => (
          <Card key={c.id}>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded bg-[#00d4ff11] border border-[#00d4ff22] flex items-center justify-center">
                    <Plug size={14} className="text-[#00d4ff]" />
                  </div>
                  <div className="text-sm font-medium text-[#e2e8f0]">{c.name}</div>
                </div>
                {c.configError && (
                  <span title={`Couldn't read config: ${c.configError}`}>
                    <TriangleAlert size={14} className="text-[#ffab40]" />
                  </span>
                )}
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-[#4a5568]">Canister ID</span>
                  <CanisterID id={c.id} />
                </div>
                <div className="flex justify-between">
                  <span className="text-[#4a5568]">Messages processed</span>
                  <span className="text-[#e2e8f0] font-mono">{c.messagesProcessed !== null ? c.messagesProcessed.toLocaleString() : "…"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[#4a5568]">Forwards to</span>
                  {c.agentCanister ? (
                    <span className="text-[#00d4ff] font-mono flex items-center gap-1">
                      <ArrowRight size={11} /> {agentNameById.get(c.agentCanister) ?? `${c.agentCanister.slice(0, 8)}…`}
                    </span>
                  ) : (
                    <span className="text-[#4a5568]">{c.configError ? "unknown" : "not configured"}</span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function Agents() {
  const { job } = useOutletContext<ProjectContext>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("agents");

  const tabs = [
    { id: "agents", label: "Agents & Channels", icon: <Bot size={13} /> },
    { id: "models", label: "Models", icon: <Cpu size={13} /> },
    { id: "memory", label: "Memory", icon: <Database size={13} /> },
    { id: "logs", label: "Logs", icon: <ScrollText size={13} /> },
  ];

  return (
    <div className="flex flex-col h-full animate-fade-in">
      <div className="px-6 pt-4 pb-0 border-b border-[#1e2d47]">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-lg font-semibold text-[#e2e8f0]">AI Agents</h1>
          {job && (
            <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => navigate(`/project/${job.id}/agents/map`)}>
              <Workflow size={13} /> Agent Map
            </Button>
          )}
        </div>
        <div className="flex gap-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                "flex items-center gap-1.5 px-4 py-2.5 text-sm transition-colors border-b-2 -mb-px",
                activeTab === tab.id
                  ? "text-[#00d4ff] border-[#00d4ff]"
                  : "text-[#8892a4] border-transparent hover:text-[#e2e8f0]"
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {activeTab === "agents" && <AgentsTab />}
        {activeTab === "models" && <ModelsTab />}
        {activeTab === "memory" && <MemoryTab />}
        {activeTab === "logs" && <AgentLogsTab />}
      </div>
    </div>
  );
}
