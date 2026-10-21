// Mock data with ICP-style identifiers

import { Principal } from "@icp-sdk/core/principal";
import { MarketplaceItemType, type MarketplaceItem } from "../bindings/backend";

export type ServiceStatus = "healthy" | "degraded" | "error" | "stopped";
export type Network = "mainnet" | "testnet" | "local";

export interface Project {
  id: string;
  name: string;
  slug: string;
  network: Network;
  owner: string;
  createdAt: string;
  services: ServiceInfo[];
  cyclesBalance: number;
  cyclesMax: number;
  burnRatePerDay: number;
  lastDeployed: string;
}

export interface ServiceInfo {
  name: string;
  status: ServiceStatus;
  canisterId: string;
  wasmVersion: string;
  lastUpdated: string;
}

export interface User {
  id: string;
  principal: string;
  displayName: string;
  provider: string;
  createdAt: string;
  lastActive: string;
  status: "active" | "disabled";
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsed: string;
  expiresAt: string | null;
}

export interface StorageFile {
  id: string;
  name: string;
  path: string;
  size: number;
  mimeType: string;
  bucket: string;
  uploadedAt: string;
  publicUrl: string | null;
}

export interface StorageBucket {
  id: string;
  name: string;
  fileCount: number;
  sizeUsed: number;
  access: "public" | "private" | "authenticated";
  createdAt: string;
}

export interface AnalyticsEvent {
  id: string;
  timestamp: string;
  name: string;
  principal: string;
  properties: Record<string, unknown>;
}

export interface Agent {
  id: string;
  name: string;
  model: string;
  status: ServiceStatus;
  lastInvoked: string;
  invocationCount: number;
  canisterId: string;
  template: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  service: string;
  level: "ERROR" | "WARN" | "INFO" | "DEBUG";
  message: string;
  detail?: Record<string, unknown>;
}

// ─── Projects ──────────────────────────────────────────────────────────────

export const MOCK_PROJECTS: Project[] = [
  {
    id: "proj-1",
    name: "NeuralDAO",
    slug: "neuraldao",
    network: "mainnet",
    owner: "rdmx6-jaaaa-aaaaa-aaadq-cai",
    createdAt: "2025-09-12T10:00:00Z",
    lastDeployed: "2026-03-04T18:32:00Z",
    cyclesBalance: 842_000_000_000,
    cyclesMax: 1_000_000_000_000,
    burnRatePerDay: 12_000_000_000,
    services: [
      { name: "Auth", status: "healthy", canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai", wasmVersion: "1.4.2", lastUpdated: "2026-03-04T18:32:00Z" },
      { name: "Storage", status: "healthy", canisterId: "qoctq-giaaa-aaaaa-aaaea-cai", wasmVersion: "1.2.0", lastUpdated: "2026-02-28T09:15:00Z" },
      { name: "Analytics", status: "degraded", canisterId: "rkp4c-7iaaa-aaaaa-aaaca-cai", wasmVersion: "1.1.3", lastUpdated: "2026-02-20T14:00:00Z" },
      { name: "Agents", status: "healthy", canisterId: "renrk-eyaaa-aaaaa-aaada-cai", wasmVersion: "2.0.1", lastUpdated: "2026-03-01T11:20:00Z" },
      { name: "Config", status: "healthy", canisterId: "rno2w-sqaaa-aaaaa-aaacq-cai", wasmVersion: "1.0.5", lastUpdated: "2026-01-15T08:00:00Z" },
    ],
  },
  {
    id: "proj-2",
    name: "ICP Marketplace",
    slug: "icp-marketplace",
    network: "mainnet",
    owner: "2vxsx-fae",
    createdAt: "2025-11-03T08:00:00Z",
    lastDeployed: "2026-02-28T12:00:00Z",
    cyclesBalance: 230_000_000_000,
    cyclesMax: 1_000_000_000_000,
    burnRatePerDay: 8_000_000_000,
    services: [
      { name: "Auth", status: "healthy", canisterId: "by6od-j4aaa-aaaaa-qaadq-cai", wasmVersion: "1.4.2", lastUpdated: "2026-02-28T12:00:00Z" },
      { name: "Storage", status: "error", canisterId: "bkyz2-fmaaa-aaaaa-qaaaq-cai", wasmVersion: "1.2.0", lastUpdated: "2026-02-10T06:00:00Z" },
      { name: "Analytics", status: "stopped", canisterId: "br5f7-7uaaa-aaaaa-qaaca-cai", wasmVersion: "1.0.0", lastUpdated: "2026-01-01T00:00:00Z" },
      { name: "Config", status: "healthy", canisterId: "b3urw-xyaaa-aaaaa-qaaeq-cai", wasmVersion: "1.0.5", lastUpdated: "2026-02-28T12:00:00Z" },
    ],
  },
  {
    id: "proj-3",
    name: "Motoko Starter",
    slug: "motoko-starter",
    network: "testnet",
    owner: "aaaaa-aa",
    createdAt: "2026-01-20T10:00:00Z",
    lastDeployed: "2026-03-03T09:00:00Z",
    cyclesBalance: 980_000_000_000,
    cyclesMax: 1_000_000_000_000,
    burnRatePerDay: 2_000_000_000,
    services: [
      { name: "Auth", status: "healthy", canisterId: "t6rzw-2iaaa-aaaaa-aaama-cai", wasmVersion: "1.4.2", lastUpdated: "2026-03-03T09:00:00Z" },
      { name: "Config", status: "healthy", canisterId: "tqtu6-byaaa-aaaaa-aaana-cai", wasmVersion: "1.0.5", lastUpdated: "2026-03-03T09:00:00Z" },
    ],
  },
];

export const ACTIVE_PROJECT = MOCK_PROJECTS[0];

// ─── Users ─────────────────────────────────────────────────────────────────

export const MOCK_USERS: User[] = [
  { id: "u-1", principal: "rdmx6-jaaaa-aaaaa-aaadq-cai", displayName: "Alice Chen", provider: "Internet Identity", createdAt: "2025-09-15T10:00:00Z", lastActive: "2026-03-05T08:12:00Z", status: "active" },
  { id: "u-2", principal: "2vxsx-fae", displayName: "Bob Nakamoto", provider: "NFID", createdAt: "2025-10-01T14:30:00Z", lastActive: "2026-03-04T21:45:00Z", status: "active" },
  { id: "u-3", principal: "aaaaa-aa", displayName: "Carol Vance", provider: "Internet Identity", createdAt: "2025-11-12T09:00:00Z", lastActive: "2026-02-28T16:20:00Z", status: "active" },
  { id: "u-4", principal: "g3wsl-eqaaa-aaaaa-aaawa-cai", displayName: "Dave Park", provider: "GitHub", createdAt: "2025-12-05T11:00:00Z", lastActive: "2026-03-01T10:00:00Z", status: "disabled" },
  { id: "u-5", principal: "hrqz7-qyaaa-aaaaa-aaaqq-cai", displayName: "Eve Okafor", provider: "Internet Identity", createdAt: "2026-01-08T08:00:00Z", lastActive: "2026-03-05T07:30:00Z", status: "active" },
  { id: "u-6", principal: "hpiaq-lyaaa-aaaaa-aaara-cai", displayName: "Frank Torres", provider: "Plug Wallet", createdAt: "2026-02-01T13:00:00Z", lastActive: "2026-03-03T15:00:00Z", status: "active" },
];

// ─── API Keys ───────────────────────────────────────────────────────────────

export const MOCK_API_KEYS: ApiKey[] = [
  { id: "key-1", name: "Production Frontend", prefix: "cc_live_7xK2m", scopes: ["auth:read", "auth:write", "storage:read", "storage:write", "analytics:read"], createdAt: "2025-09-20T10:00:00Z", lastUsed: "2026-03-05T09:00:00Z", expiresAt: null },
  { id: "key-2", name: "Analytics Exporter", prefix: "cc_live_9nPqR", scopes: ["analytics:read"], createdAt: "2025-11-01T10:00:00Z", lastUsed: "2026-03-04T18:00:00Z", expiresAt: "2026-06-01T00:00:00Z" },
  { id: "key-3", name: "CI/CD Deploy Key", prefix: "cc_live_mK8sT", scopes: ["storage:write", "agents:invoke"], createdAt: "2026-01-15T10:00:00Z", lastUsed: "2026-03-03T12:00:00Z", expiresAt: null },
  { id: "key-4", name: "Dev Local", prefix: "cc_test_aB3xZ", scopes: ["auth:read", "storage:read"], createdAt: "2026-02-10T10:00:00Z", lastUsed: "2026-02-28T17:00:00Z", expiresAt: "2026-04-01T00:00:00Z" },
];

// ─── Storage ────────────────────────────────────────────────────────────────

export const MOCK_BUCKETS: StorageBucket[] = [
  { id: "bucket-1", name: "public-assets", fileCount: 1284, sizeUsed: 542_000_000, access: "public", createdAt: "2025-09-12T10:00:00Z" },
  { id: "bucket-2", name: "user-uploads", fileCount: 8721, sizeUsed: 2_100_000_000, access: "authenticated", createdAt: "2025-09-12T10:00:00Z" },
  { id: "bucket-3", name: "private-docs", fileCount: 43, sizeUsed: 28_000_000, access: "private", createdAt: "2025-11-01T10:00:00Z" },
];

export const MOCK_FILES: StorageFile[] = [
  { id: "f-1", name: "hero-banner.webp", path: "/public-assets/images/hero-banner.webp", size: 284_000, mimeType: "image/webp", bucket: "public-assets", uploadedAt: "2026-02-15T10:00:00Z", publicUrl: "https://cdn.example.icp/public-assets/images/hero-banner.webp" },
  { id: "f-2", name: "logo.svg", path: "/public-assets/icons/logo.svg", size: 4_200, mimeType: "image/svg+xml", bucket: "public-assets", uploadedAt: "2025-09-12T10:00:00Z", publicUrl: "https://cdn.example.icp/public-assets/icons/logo.svg" },
  { id: "f-3", name: "user-avatar-2vxsx.jpg", path: "/user-uploads/avatars/user-avatar-2vxsx.jpg", size: 128_000, mimeType: "image/jpeg", bucket: "user-uploads", uploadedAt: "2026-01-20T14:30:00Z", publicUrl: null },
  { id: "f-4", name: "export-2026-03.csv", path: "/private-docs/exports/export-2026-03.csv", size: 2_800_000, mimeType: "text/csv", bucket: "private-docs", uploadedAt: "2026-03-01T09:00:00Z", publicUrl: null },
  { id: "f-5", name: "contract-v2.pdf", path: "/private-docs/legal/contract-v2.pdf", size: 8_400_000, mimeType: "application/pdf", bucket: "private-docs", uploadedAt: "2026-02-20T11:00:00Z", publicUrl: null },
  { id: "f-6", name: "app-bundle.js", path: "/public-assets/js/app-bundle.js", size: 1_240_000, mimeType: "text/javascript", bucket: "public-assets", uploadedAt: "2026-03-04T18:32:00Z", publicUrl: "https://cdn.example.icp/public-assets/js/app-bundle.js" },
];

// ─── Analytics ──────────────────────────────────────────────────────────────

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

// ─── Agents ─────────────────────────────────────────────────────────────────

export const MOCK_AGENTS: Agent[] = [
  { id: "agent-1", name: "Support Assistant", model: "claude-opus-4-6 (HTTPS outcall)", status: "healthy", lastInvoked: "2026-03-05T09:10:00Z", invocationCount: 8_241, canisterId: "s5r7v-aaaaa-aaaaa-bbbbb-cai", template: "Chat Agent" },
  { id: "agent-2", name: "Document RAG", model: "on-chain (llama-3-8b.wasm)", status: "healthy", lastInvoked: "2026-03-04T22:15:00Z", invocationCount: 1_892, canisterId: "s9k2m-bbbbb-aaaaa-ccccc-cai", template: "RAG Agent" },
  { id: "agent-3", name: "Proposal Analyzer", model: "claude-sonnet-4-6 (HTTPS outcall)", status: "degraded", lastInvoked: "2026-03-03T10:00:00Z", invocationCount: 342, canisterId: "t2n8p-ccccc-aaaaa-ddddd-cai", template: "Task Agent" },
];

// ─── Logs ───────────────────────────────────────────────────────────────────

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

// ─── Cycles chart data ───────────────────────────────────────────────────────

export const CYCLES_HISTORY = [
  { date: "Feb 27", auth: 8_200_000_000, storage: 5_400_000_000, analytics: 2_100_000_000, agents: 3_800_000_000 },
  { date: "Feb 28", auth: 8_500_000_000, storage: 5_200_000_000, analytics: 2_300_000_000, agents: 4_100_000_000 },
  { date: "Mar 1", auth: 7_900_000_000, storage: 5_600_000_000, analytics: 1_800_000_000, agents: 3_500_000_000 },
  { date: "Mar 2", auth: 5_200_000_000, storage: 3_400_000_000, analytics: 1_200_000_000, agents: 2_200_000_000 },
  { date: "Mar 3", auth: 9_100_000_000, storage: 6_200_000_000, analytics: 2_600_000_000, agents: 4_800_000_000 },
  { date: "Mar 4", auth: 10_200_000_000, storage: 6_800_000_000, analytics: 2_900_000_000, agents: 5_200_000_000 },
  { date: "Mar 5", auth: 8_800_000_000, storage: 5_900_000_000, analytics: 2_400_000_000, agents: 4_400_000_000 },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

export function formatCycles(n: number): string {
  if (n >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(2)}T`;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n.toString();
}

export function formatBytes(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)} KB`;
  return `${n} B`;
}

export function truncatePrincipal(id: string, chars = 6): string {
  if (id.length <= chars * 2 + 3) return id;
  return `${id.slice(0, chars)}...${id.slice(-chars)}`;
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

// ─── Marketplace preview (disclosed mock) ───────────────────────────────────

/** Sample marketplace listings - shown on `Overview.tsx`'s Marketplace
 * section only as a fallback while `list_marketplace_items` genuinely comes
 * back empty (nothing's been published to this `backend` yet), so the
 * Featured layout has something to preview instead of an empty state.
 * Negative ids on purpose: real items are assigned non-negative ids by
 * `backend`, so these can never collide with one - `ProductDetail.tsx`
 * uses that to tell a preview id from a real one without a extra flag. */
export const MOCK_MARKETPLACE_ITEMS: MarketplaceItem[] = [
  {
    id: -1n,
    package_slug: "stripe-billing-connector",
    title: "Stripe Billing Connector",
    publisher: Principal.anonymous(),
    description: "Subscription billing and webhook sync for ICP projects - checkout sessions, invoices, and usage-based metering, wired straight into your project's own canisters.",
    created_at: BigInt(Date.now()) * 1_000_000n,
    item_type: MarketplaceItemType.Package,
    download_url: "",
    wasm_hash: new Uint8Array(32),
    git_repo_url: "https://github.com/example/stripe-connector",
    purchases: [],
    downloads: 482n,
  },
  {
    id: -2n,
    package_slug: "realtime-presence",
    title: "Realtime Presence",
    publisher: Principal.anonymous(),
    description: "WebSocket-style presence and live cursors for collaborative apps, backed by a canister that tracks who's online and broadcasts state changes to every connected client.",
    created_at: BigInt(Date.now()) * 1_000_000n,
    item_type: MarketplaceItemType.Package,
    download_url: "",
    wasm_hash: new Uint8Array(32),
    git_repo_url: "https://github.com/example/realtime-presence",
    purchases: [],
    downloads: 317n,
  },
  {
    id: -3n,
    package_slug: "pdf-generator",
    title: "PDF Generator",
    publisher: Principal.anonymous(),
    description: "Server-side PDF rendering from HTML templates - invoices, receipts, and reports generated and stored directly in your project's own asset storage.",
    created_at: BigInt(Date.now()) * 1_000_000n,
    item_type: MarketplaceItemType.Package,
    download_url: "",
    wasm_hash: new Uint8Array(32),
    git_repo_url: "https://github.com/example/pdf-generator",
    price: 499_000_000n,
    purchases: [],
    downloads: 201n,
  },
  {
    id: -4n,
    package_slug: "email-digest-scheduler",
    title: "Email Digest Scheduler",
    publisher: Principal.anonymous(),
    description: "Cron-style scheduled digests over your project's own data, delivered by email - daily/weekly summaries with no external job runner to manage.",
    created_at: BigInt(Date.now()) * 1_000_000n,
    item_type: MarketplaceItemType.Package,
    download_url: "",
    wasm_hash: new Uint8Array(32),
    git_repo_url: "https://github.com/example/email-digest",
    purchases: [],
    downloads: 156n,
  },
  {
    id: -5n,
    package_slug: "full-text-search",
    title: "Full-Text Search",
    publisher: Principal.anonymous(),
    description: "Drop-in full-text search over any canister's stored records - tokenized indexing, ranked results, and typo-tolerant queries.",
    created_at: BigInt(Date.now()) * 1_000_000n,
    item_type: MarketplaceItemType.Package,
    download_url: "",
    wasm_hash: new Uint8Array(32),
    git_repo_url: "https://github.com/example/full-text-search",
    price: 999_000_000n,
    purchases: [],
    downloads: 98n,
  },
  {
    id: -6n,
    package_slug: "audit-log",
    title: "Audit Log",
    publisher: Principal.anonymous(),
    description: "Tamper-evident audit trail for every write your project's canisters make - who changed what, and when, queryable from a dedicated log canister.",
    created_at: BigInt(Date.now()) * 1_000_000n,
    item_type: MarketplaceItemType.Package,
    download_url: "",
    wasm_hash: new Uint8Array(32),
    git_repo_url: "https://github.com/example/audit-log",
    purchases: [],
    downloads: 64n,
  },
];
