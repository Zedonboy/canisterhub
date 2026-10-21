import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import { lazy, Suspense } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth } from "@/components/RequireAuth";

const Login = lazy(() => import("@/pages/Login"));
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Account = lazy(() => import("@/pages/Account"));
// Disabled for production launch (no funds for AI/marketplace yet).
// const Marketplace = lazy(() => import("@/pages/Marketplace"));
const Overview = lazy(() => import("@/pages/Overview"));
const Auth = lazy(() => import("@/pages/Auth"));
const AuthDetail = lazy(() => import("@/pages/AuthDetail"));
const Storage = lazy(() => import("@/pages/Storage"));
const StorageDetail = lazy(() => import("@/pages/StorageDetail"));
const DatabasePage = lazy(() => import("@/pages/Database"));
const CanisterSettings = lazy(() => import("@/pages/CanisterSettings"));
const CanisterViewData = lazy(() => import("@/pages/CanisterViewData"));
const Analytics = lazy(() => import("@/pages/Analytics"));
const Agents = lazy(() => import("@/pages/Agents"));
const AgentMap = lazy(() => import("@/pages/AgentMap"));
const SettingsPage = lazy(() => import("@/pages/Settings"));
const WalletPage = lazy(() => import("@/pages/Wallet"));
const ProductInstall = lazy(() => import("@/pages/ProductInstall"));
// const MarketplaceItemDetail = lazy(() => import("@/pages/MarketplaceItemDetail"));
const PublisherSetup = lazy(() => import("@/pages/PublisherSetup"));
// const Orchestrate = lazy(() => import("@/pages/Orchestrate"));
const Runtime = lazy(() => import("@/pages/Runtime"));
const TemplateInstall = lazy(() => import("@/pages/TemplateInstall"));

function Fallback() {
  return <div className="min-h-screen bg-[#0a0e1a]" />;
}

export default function App() {
  return (
    <Router>
      <Suspense fallback={<Fallback />}>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/login" element={<Login />} />
          <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
          <Route path="/account" element={<RequireAuth><Account /></RequireAuth>} />
          {/* Disabled for production launch (no funds for AI/marketplace yet).
          <Route path="/marketplace" element={<RequireAuth><Marketplace /></RequireAuth>} />
          <Route path="/market/product/:product_id" element={<RequireAuth><ProductInstall /></RequireAuth>} />
          <Route path="/market/publisher" element={<RequireAuth><PublisherSetup /></RequireAuth>} />
          */}
          <Route path="/templates/:slug" element={<RequireAuth><TemplateInstall /></RequireAuth>} />
          <Route path="/project/:id" element={<RequireAuth><AppShell /></RequireAuth>}>
            <Route path="overview" element={<Overview />} />
            {/* <Route path="overview/product/:product_id" element={<MarketplaceItemDetail />} /> */}
            <Route path="auth" element={<Auth />} />
            <Route path="auth/:canisterId" element={<AuthDetail />} />
            <Route path="storage" element={<Storage />} />
            <Route path="storage/:canisterId" element={<StorageDetail />} />
            <Route path="database" element={<DatabasePage />} />
            <Route path="canister/:canisterId/settings" element={<CanisterSettings />} />
            <Route path="canister/:canisterId/view-data" element={<CanisterViewData />} />
            <Route path="analytics" element={<Analytics />} />
            <Route path="agents" element={<Agents />} />
            <Route path="agents/map" element={<AgentMap />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="wallet" element={<WalletPage />} />
            {/* Billing merged into Wallet - keep the old path working for
                anyone with a stale link/bookmark. */}
            <Route path="billing" element={<Navigate to="../wallet" replace />} />
            {/* Logs used to be a tab on Analytics (now a canister-listing
                page instead, its old dashboard content - including that
                tab - moved to `packages/analytics-dashboard`) - keep the
                old path working for anyone with a stale link/bookmark. */}
            <Route path="logs" element={<Navigate to="../analytics" replace />} />
            {/* Secretary (AI) disabled for production launch - bounce stale links/
                the remaining "Ask AI" buttons to Overview instead of a blank page. */}
            <Route path="orchestrate" element={<Navigate to="../overview" replace />} />
            <Route path="runtime" element={<Runtime />} />
          </Route>
        </Routes>
      </Suspense>
    </Router>
  );
}
