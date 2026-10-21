import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { clsx } from "clsx";
import {
  LayoutDashboard, Shield, HardDrive, BarChart2,
  Bot, Settings, ScrollText, CreditCard, Search, ChevronRight,
  Sparkles, Store
} from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import type { ReactNode } from "react";

interface Command {
  id: string;
  label: string;
  description: string;
  icon: ReactNode;
  action: () => void;
  category: string;
}

interface CommandPaletteProps {
  projectId?: string;
}

export function CommandPalette({ projectId }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const navigate = useNavigate();
  const pid = projectId ?? "proj-1";
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo((): Command[] => [
    { id: "dashboard", label: "Go to Dashboard",  description: "View all projects",       icon: <LayoutDashboard size={14} />, action: () => navigate("/dashboard"),                   category: "Navigate" },
    { id: "overview",  label: "Project Overview", description: "Health summary",           icon: <LayoutDashboard size={14} />, action: () => navigate(`/project/${pid}/overview`),    category: "Navigate" },
    { id: "auth",      label: "Auth Canister",    description: "Manage users & providers", icon: <Shield size={14} />,         action: () => navigate(`/project/${pid}/auth`),         category: "Navigate" },
    { id: "storage",   label: "Storage Canister", description: "Files & buckets",          icon: <HardDrive size={14} />,      action: () => navigate(`/project/${pid}/storage`),      category: "Navigate" },
    { id: "analytics", label: "Analytics",        description: "Events & funnels",         icon: <BarChart2 size={14} />,      action: () => navigate(`/project/${pid}/analytics`),    category: "Navigate" },
    { id: "agents",    label: "AI Agents",        description: "Deploy & manage agents",   icon: <Bot size={14} />,            action: () => navigate(`/project/${pid}/agents`),       category: "Navigate" },
    { id: "settings",  label: "Settings",         description: "API keys & config",        icon: <Settings size={14} />,       action: () => navigate(`/project/${pid}/settings`),     category: "Navigate" },
    { id: "logs",      label: "Logs",             description: "Unified log viewer",       icon: <ScrollText size={14} />,     action: () => navigate(`/project/${pid}/analytics?tab=logs`), category: "Navigate" },
    { id: "wallet",    label: "Wallet & Billing", description: "Token balances & cycles",  icon: <CreditCard size={14} />,     action: () => navigate(`/project/${pid}/wallet`),       category: "Navigate" },
    // Disabled for production launch (no funds for AI/marketplace yet)
    // { id: "orchestrate", label: "Secretary",      description: "Command your infra with AI", icon: <Sparkles size={14} />,     action: () => navigate(`/project/${pid}/orchestrate`),  category: "Navigate" },
    // { id: "marketplace", label: "Marketplace",    description: "Browse canister products", icon: <Store size={14} />,          action: () => navigate("/marketplace"),                 category: "Navigate" },
  ], [pid, navigate]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
    );
  }, [query, commands]);

  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setSelected(0);
      }
      if (!open) return;
      if (e.key === "Escape") { setOpen(false); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, filtered.length - 1)); }
      if (e.key === "ArrowUp")   { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = filtered[selected];
        if (cmd) { cmd.action(); setOpen(false); }
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [open, filtered, selected]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  return (
    <Dialog open={open} onClose={() => setOpen(false)} className="max-w-lg overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e2d47]">
        <Search size={16} className="text-[#4a5568] flex-shrink-0" />
        <input
          ref={inputRef}
          className="flex-1 bg-transparent text-sm text-[#e2e8f0] placeholder-[#4a5568] outline-none"
          placeholder="Search commands..."
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
        />
        <kbd className="text-[10px] text-[#4a5568] bg-[#1a2236] border border-[#1e2d47] rounded px-1.5 py-0.5">ESC</kbd>
      </div>
      <div className="max-h-80 overflow-y-auto py-1">
        {filtered.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-[#4a5568]">No commands found</div>
        )}
        {filtered.map((cmd, i) => (
          <button
            key={cmd.id}
            className={clsx(
              "w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors",
              selected === i
                ? "bg-[#00d4ff11] text-[#e2e8f0]"
                : "hover:bg-[#131929] text-[#8892a4]"
            )}
            onMouseEnter={() => setSelected(i)}
            onClick={() => { cmd.action(); setOpen(false); }}
          >
            <span className="text-[#00d4ff] flex-shrink-0">{cmd.icon}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-[#e2e8f0]">{cmd.label}</div>
              <div className="text-xs text-[#4a5568]">{cmd.description}</div>
            </div>
            <ChevronRight size={12} className="text-[#4a5568]" />
          </button>
        ))}
      </div>
      <div className="px-4 py-2 border-t border-[#1e2d47] flex items-center gap-3 text-[10px] text-[#4a5568]">
        <span><kbd className="bg-[#1a2236] border border-[#1e2d47] rounded px-1">↑↓</kbd> navigate</span>
        <span><kbd className="bg-[#1a2236] border border-[#1e2d47] rounded px-1">↵</kbd> select</span>
        <span><kbd className="bg-[#1a2236] border border-[#1e2d47] rounded px-1">⌘K</kbd> toggle</span>
      </div>
    </Dialog>
  );
}
