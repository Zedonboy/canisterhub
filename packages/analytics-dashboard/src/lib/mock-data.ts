// Illustrative sample data for this dashboard - trimmed copy of the
// relevant slice of `frontend/src/lib/mock-data.ts` (the Projects/Users/
// API-keys/Storage/Cycles-history data that file also holds belongs to
// the main dashboard app, not here). None of this is backed by a real
// canister - there's no real usage-analytics/log-aggregation building
// block anywhere in this codebase (see this app's own `App.tsx` header
// comment), so every chart below stays sample data on purpose.

export interface AnalyticsEvent {
  id: string;
  timestamp: string;
  name: string;
  principal: string;
  properties: Record<string, unknown>;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  service: string;
  level: "ERROR" | "WARN" | "INFO" | "DEBUG";
  message: string;
  detail?: Record<string, unknown>;
}

export const MOCK_EVENTS: AnalyticsEvent[] = [
  { id: "ev-1", timestamp: "2026-03-05T09:12:34Z", name: "page_view", principal: "2vxsx-fae", properties: { page: "/dashboard", referrer: "direct" } },
  { id: "ev-2", timestamp: "2026-03-05T09:11:00Z", name: "button_click", principal: "rdmx6-jaaaa-aaaaa-aaadq-cai", properties: { element: "deploy-canister", page: "/project/proj-1/overview" } },
  { id: "ev-3", timestamp: "2026-03-05T09:10:45Z", name: "api_call", principal: "aaaaa-aa", properties: { endpoint: "/auth/login", method: "POST", status: 200 } },
  { id: "ev-4", timestamp: "2026-03-05T09:08:22Z", name: "user_login", principal: "hrqz7-qyaaa-aaaaa-aaaqq-cai", properties: { provider: "Internet Identity" } },
  { id: "ev-5", timestamp: "2026-03-05T09:05:10Z", name: "file_upload", principal: "2vxsx-fae", properties: { bucket: "user-uploads", size: 128000, mimeType: "image/jpeg" } },
  { id: "ev-6", timestamp: "2026-03-05T09:02:58Z", name: "page_view", principal: "hpiaq-lyaaa-aaaaa-aaara-cai", properties: { page: "/project/proj-1/auth", referrer: "/dashboard" } },
];

export const DAU_DATA = [
  { date: "Feb 27", value: 142 },
  { date: "Feb 28", value: 168 },
  { date: "Mar 1", value: 155 },
  { date: "Mar 2", value: 89 },
  { date: "Mar 3", value: 201 },
  { date: "Mar 4", value: 234 },
  { date: "Mar 5", value: 198 },
];

export const TOP_EVENTS = [
  { name: "page_view", count: 12_840 },
  { name: "api_call", count: 8_321 },
  { name: "user_login", count: 3_204 },
  { name: "button_click", count: 2_891 },
  { name: "file_upload", count: 1_204 },
  { name: "agent_invoke", count: 892 },
  { name: "user_logout", count: 741 },
  { name: "setting_change", count: 412 },
];

export const MOCK_LOGS: LogEntry[] = [
  { id: "log-1", timestamp: "2026-03-05T09:14:01Z", service: "AUTH", level: "INFO", message: "User login — principal: 2vxsx-fae", detail: { provider: "Internet Identity", ip: "145.20.31.12" } },
  { id: "log-2", timestamp: "2026-03-05T09:13:45Z", service: "STORAGE", level: "INFO", message: "File upload complete — /user-uploads/avatars/user-avatar-2vxsx.jpg (128 KB)", detail: { size: 128000, bucket: "user-uploads" } },
  { id: "log-3", timestamp: "2026-03-05T09:12:34Z", service: "ANALYTICS", level: "WARN", message: "High ingestion latency detected — 842ms (threshold: 500ms)", detail: { latency_ms: 842, threshold_ms: 500 } },
  { id: "log-4", timestamp: "2026-03-05T09:11:00Z", service: "AGENTS", level: "INFO", message: "Agent invocation — Support Assistant — caller: rdmx6-jaaaa-aaaaa-aaadq-cai", detail: { latency_ms: 1240, cycles_used: 2_000_000 } },
  { id: "log-5", timestamp: "2026-03-05T09:08:30Z", service: "AUTH", level: "ERROR", message: "Failed login attempt — unknown principal from IP 203.0.113.42", detail: { ip: "203.0.113.42", attempts: 3 } },
  { id: "log-6", timestamp: "2026-03-05T09:05:12Z", service: "STORAGE", level: "DEBUG", message: "Bucket ACL check — user-uploads — principal: hrqz7-qyaaa-aaaaa-aaaqq-cai — ALLOW", detail: {} },
  { id: "log-7", timestamp: "2026-03-05T09:02:00Z", service: "CONFIG", level: "INFO", message: "API key rotated — 'CI/CD Deploy Key' — prefix: cc_live_mK8sT", detail: { key_id: "key-3" } },
  { id: "log-8", timestamp: "2026-03-05T08:58:41Z", service: "AGENTS", level: "WARN", message: "Proposal Analyzer — HTTPS outcall timeout — retrying (1/3)", detail: { timeout_ms: 30000 } },
];
