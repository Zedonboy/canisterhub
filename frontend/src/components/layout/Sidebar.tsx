import { useNavigate, useLocation } from "react-router-dom";
import { clsx } from "clsx";
import {
  LayoutDashboard, Shield, HardDrive, /* BarChart2, */
  /* Bot, */ Settings, /* Database, */
  Zap, ChevronDown, ChevronsLeft, ChevronsRight, Sparkles, Wallet, Cpu, ScrollText, X,
} from "lucide-react";
import type { Project } from "@/lib/backend";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

interface NavItem {
  label: string;
  path: string;
  icon: ReactNode;
  badge?: string;
}

interface SidebarProps {
  projectId: string;
  /** Real job data, once `AppShell` has fetched it - `null` while loading
   * or if the fetch failed, in which case this falls back to `projectId`
   * itself for display rather than any mock project. */
  job: Project | null;
  /** Below the `md` breakpoint the sidebar renders as an off-canvas drawer
   * instead of taking up permanent width - `AppShell` owns this open/close
   * state since `Header`'s hamburger button (a sibling, not a descendant)
   * needs to trigger it too. */
  mobileOpen: boolean;
  onMobileClose: () => void;
}

/** Collapsed/expanded persists across visits (a per-browser UI preference,
 * not project state) - read synchronously at module init so the sidebar
 * doesn't flash expanded-then-collapse on reload. */
const COLLAPSE_KEY = "sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

export function Sidebar({ projectId, job, mobileOpen, onMobileClose }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // The desktop collapsed/expanded preference shouldn't also decide
  // whether the mobile drawer shows icons-only - the drawer is only ever
  // opened deliberately (hamburger tap), so it always shows full labels.
  const showCollapsed = collapsed && !mobileOpen;

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      // per-viewer convenience only - fine to drop if storage is unavailable
    }
  }, [collapsed]);

  const navItems: NavItem[] = [
    { label: "Overview",   path: `/project/${projectId}/overview`,   icon: <LayoutDashboard size={15} /> },
    // Disabled for production launch (no funds for AI yet)
    // { label: "Secretary",  path: `/project/${projectId}/orchestrate`, icon: <Sparkles size={15} />, badge: "AI" },
    { label: "Wallet & Billing", path: `/project/${projectId}/wallet`, icon: <Wallet size={15} /> },
    { label: "Auth",       path: `/project/${projectId}/auth`,       icon: <Shield size={15} /> },
    { label: "Storage",    path: `/project/${projectId}/storage`,    icon: <HardDrive size={15} /> },
    // { label: "Database",   path: `/project/${projectId}/database`,   icon: <Database size={15} /> },
    { label: "Runtime",    path: `/project/${projectId}/runtime`,    icon: <Cpu size={15} /> },
    { label: "Logs",       path: `/project/${projectId}/logs`,       icon: <ScrollText size={15} /> },
    // Disabled for production launch
    // { label: "Analytics",  path: `/project/${projectId}/analytics`,  icon: <BarChart2 size={15} /> },
    // { label: "Agents",     path: `/project/${projectId}/agents`,     icon: <Bot size={15} /> },
    { label: "Settings",   path: `/project/${projectId}/settings`,   icon: <Settings size={15} /> },
  ];

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + "/");

  const displayName = job?.project_name ?? job?.request.slice(0, 30) ?? projectId;

  const go = (path: string) => {
    navigate(path);
    onMobileClose();
  };

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 bg-black/60 z-40 md:hidden" onClick={onMobileClose} />
      )}
      <nav
        className={clsx(
          "flex flex-col bg-[#0a0e1a] border-r border-[#1e2d47] h-full flex-shrink-0 w-64",
          "fixed inset-y-0 left-0 z-50 transition-transform duration-200 ease-in-out",
          "md:static md:z-auto md:transition-[width] md:duration-150 md:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          showCollapsed ? "md:w-14" : "md:w-56"
        )}
      >
        <div
          className={clsx(
            "flex items-center gap-2 py-4 border-b border-[#1e2d47] cursor-pointer",
            showCollapsed ? "md:justify-center md:px-2" : "px-4"
          )}
          onClick={() => go("/dashboard")}
        >
          <div className="w-7 h-7 bg-[#00d4ff] rounded flex items-center justify-center flex-shrink-0">
            <Zap size={14} className="text-[#0a0e1a]" fill="currentColor" />
          </div>
          {!showCollapsed && (
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[#e2e8f0] leading-tight">Canisterhub</div>
              <div className="text-[10px] text-[#4a5568] font-mono">Compute &amp; agents</div>
            </div>
          )}
          <button
            className="md:hidden ml-auto p-1 text-[#4a5568] hover:text-[#e2e8f0]"
            onClick={(e) => { e.stopPropagation(); onMobileClose(); }}
          >
            <X size={16} />
          </button>
        </div>

        {!showCollapsed && (
          <div className="px-3 py-2 border-b border-[#1e2d47]">
            <button className="w-full flex items-center justify-between px-3 py-2 rounded bg-[#0f1629] hover:bg-[#131929] transition-colors group border border-[#1e2d47]">
              <div className="text-left min-w-0">
                <div className="text-xs font-medium text-[#e2e8f0] truncate">{displayName}</div>
              </div>
              <ChevronDown size={12} className="text-[#4a5568] group-hover:text-[#8892a4] flex-shrink-0" />
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {navItems.map((item) => (
            <NavLink key={item.label} item={item} active={isActive(item.path)} collapsed={showCollapsed} onClick={() => go(item.path)} />
          ))}
        </div>

        <button
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={clsx(
            "hidden md:flex items-center gap-2 py-2.5 border-t border-[#1e2d47] text-[#4a5568] hover:text-[#e2e8f0] hover:bg-[#131929] transition-colors",
            showCollapsed ? "justify-center px-2" : "px-4"
          )}
        >
          {showCollapsed ? <ChevronsRight size={14} /> : <><ChevronsLeft size={14} /><span className="text-xs">Collapse</span></>}
        </button>
      </nav>
    </>
  );
}

function NavLink({ item, active, collapsed, onClick }: { item: NavItem; active: boolean; collapsed: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={collapsed ? item.label : undefined}
      className={clsx(
        "w-full flex items-center gap-2.5 py-2 rounded text-sm transition-all duration-100 text-left",
        collapsed ? "justify-center px-0" : "px-3",
        active
          ? "bg-[#00d4ff11] text-[#00d4ff] border border-[#00d4ff22]"
          : "text-[#8892a4] hover:bg-[#131929] hover:text-[#e2e8f0] border border-transparent"
      )}
    >
      <span className={active ? "text-[#00d4ff]" : "text-[#4a5568]"}>{item.icon}</span>
      {!collapsed && <span className="flex-1">{item.label}</span>}
      {!collapsed && item.badge && (
        <span
          className={clsx(
            "text-[9px] font-mono px-1.5 py-0.5 rounded border flex-shrink-0",
            active
              ? "border-[#00d4ff44] text-[#00d4ff] bg-[#00d4ff11]"
              : "border-[#c084fc33] text-[#c084fc] bg-[#c084fc0d]"
          )}
        >
          {item.badge}
        </span>
      )}
    </button>
  );
}
