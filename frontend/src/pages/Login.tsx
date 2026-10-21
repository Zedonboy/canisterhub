import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Zap, Shield, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/lib/auth";

/** Real Internet Identity sign-in - see `lib/auth.ts`. Replaces the old
 * mock ("network" picker, fake email/password form, a `setTimeout` in
 * place of a real login) with only what's actually real: one button that
 * opens Internet Identity and waits for a genuine delegation. Already
 * signed in (a restored session) redirects straight to the dashboard
 * rather than showing the button at all. */
export default function Login() {
  const navigate = useNavigate();
  const { status, signIn } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (status === "authenticated") navigate("/dashboard", { replace: true });
  }, [status, navigate]);

  const handleSignIn = async () => {
    setLoading(true);
    setError(null);
    try {
      await signIn();
      navigate("/dashboard", { replace: true });
    } catch (e) {
      // A closed II popup or a rejected delegation both land here - see
      // `useAuth`'s own doc comment on why this isn't swallowed.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0e1a] flex items-center justify-center p-4 relative overflow-hidden dot-grid">
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-[#00d4ff08] rounded-full blur-3xl pointer-events-none" />

      <div className="relative z-10 w-full max-w-sm animate-fade-in">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-[#00d4ff] mb-4 shadow-[0_0_32px_#00d4ff44]">
            <Zap size={28} className="text-[#0a0e1a]" fill="currentColor" />
          </div>
          <h1 className="text-2xl font-bold text-[#e2e8f0] tracking-tight">Canisterhub</h1>
          <p className="text-sm text-[#4a5568] mt-1 font-mono">A cloud platform for compute and agents</p>
        </div>

        <div className="bg-[#0f1629] border border-[#1e2d47] rounded p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-[#e2e8f0] mb-1">Sign in</h2>
            <p className="text-xs text-[#4a5568]">Connect with Internet Identity to continue</p>
          </div>

          <Button variant="primary" className="w-full justify-center gap-2" disabled={loading || status === "loading"} onClick={handleSignIn}>
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-[#0a0e1a] border-t-transparent rounded-full animate-spin" />
                Connecting...
              </span>
            ) : (
              <><Shield size={15} /> Sign in with Internet Identity</>
            )}
          </Button>

          {error && <p className="text-xs text-[#ff5252]">{error}</p>}
        </div>

        <div className="flex items-center justify-center gap-4 mt-6 text-xs text-[#4a5568]">
          <a href="#" className="hover:text-[#8892a4] flex items-center gap-1 transition-colors">
            Docs <ExternalLink size={10} />
          </a>
          <span className="text-[#1e2d47]">·</span>
          <a href="#" className="hover:text-[#8892a4] flex items-center gap-1 transition-colors">
            Status <ExternalLink size={10} />
          </a>
          <span className="text-[#1e2d47]">·</span>
          <a href="#" className="hover:text-[#8892a4] transition-colors">Privacy</a>
        </div>
      </div>
    </div>
  );
}
