import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, User, Terminal, ChevronDown, Menu } from "lucide-react";
import type { Project } from "@/lib/backend";
import { useAuth } from "@/lib/auth";

interface HeaderProps {
  job: Project | null;
  /** Opens the off-canvas sidebar drawer - only rendered (and only
   * matters) below the `md` breakpoint, see `Sidebar`'s own doc comment. */
  onMenuClick: () => void;
}

export function Header({ job, onMenuClick }: HeaderProps) {
  const navigate = useNavigate();
  const [showProfile, setShowProfile] = useState(false);
  const { status, principal, signOut } = useAuth();

  const handleSignOut = async () => {
    setShowProfile(false);
    await signOut();
    navigate("/login");
  };

  return (
    <header className="h-12 flex items-center justify-between px-2 sm:px-4 border-b border-[#1e2d47] bg-[#0a0e1a] flex-shrink-0 z-10">
      <div className="flex items-center gap-2 text-sm min-w-0">
        <button
          className="md:hidden p-2 -ml-1 rounded text-[#8892a4] hover:text-[#e2e8f0] hover:bg-[#131929] transition-colors flex-shrink-0"
          onClick={onMenuClick}
        >
          <Menu size={18} />
        </button>
        <span className="text-[#4a5568] font-mono text-xs truncate">{job?.id ?? "…"}</span>
      </div>

      <div className="flex items-center gap-1">
        <button
          className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded text-xs text-[#4a5568] border border-[#1e2d47] hover:border-[#00d4ff44] hover:text-[#8892a4] transition-colors bg-[#0f1629]"
          onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
        >
          <Terminal size={12} />
          <span className="hidden sm:inline">Command</span>
          <kbd className="hidden sm:inline text-[10px] bg-[#1a2236] border border-[#1e2d47] rounded px-1">⌘K</kbd>
        </button>

        <button className="relative p-2 rounded text-[#4a5568] hover:text-[#e2e8f0] hover:bg-[#131929] transition-colors">
          <Bell size={16} />
          <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-[#ff5252] rounded-full" />
        </button>

        <div className="relative">
          <button
            onClick={() => setShowProfile((v) => !v)}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-[#131929] transition-colors"
          >
            <div className="w-6 h-6 rounded bg-[#00d4ff22] border border-[#00d4ff44] flex items-center justify-center">
              <User size={12} className="text-[#00d4ff]" />
            </div>
            <span className="text-xs text-[#8892a4] font-mono max-w-[80px] truncate hidden sm:block">
              {status === "authenticated" ? principal : "Anonymous"}
            </span>
            <ChevronDown size={12} className="text-[#4a5568]" />
          </button>

          {showProfile && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowProfile(false)} />
              <div className="absolute right-0 top-full mt-1 w-48 bg-[#0f1629] border border-[#1e2d47] rounded shadow-xl z-50">
                <div className="px-3 py-2 border-b border-[#1e2d47]">
                  <div className="text-xs text-[#e2e8f0] font-medium">
                    {status === "authenticated" ? "Signed in" : "Not signed in"}
                  </div>
                  <div className="text-[10px] text-[#4a5568] font-mono truncate">{principal ?? "2vxsx-fae (anonymous)"}</div>
                </div>
                <div className="py-1">
                  <button
                    className="w-full text-left px-3 py-2 text-xs text-[#8892a4] hover:bg-[#131929] hover:text-[#e2e8f0] transition-colors"
                    onClick={() => { navigate(`/project/${job?.id ?? ""}/settings`); setShowProfile(false); }}
                  >
                    Settings
                  </button>
                  {status === "authenticated" ? (
                    <button className="w-full text-left px-3 py-2 text-xs text-[#ff5252] hover:bg-[#131929] transition-colors" onClick={handleSignOut}>
                      Sign Out
                    </button>
                  ) : (
                    <button
                      className="w-full text-left px-3 py-2 text-xs text-[#00d4ff] hover:bg-[#131929] transition-colors"
                      onClick={() => { navigate("/login"); setShowProfile(false); }}
                    >
                      Sign In
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
