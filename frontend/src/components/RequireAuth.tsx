import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";

/** Gates a route behind a real Internet Identity session - see
 * `lib/auth.ts`. `status === "loading"` covers the real async work of
 * restoring a previous session on first load (`AuthClient.isAuthenticated`/
 * `getIdentity`, both real calls - see `useAuth`'s own doc comment), so
 * this renders nothing rather than redirecting prematurely and bouncing an
 * already-signed-in visitor back through `/login` on every refresh. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();

  if (status === "loading") {
    return <div className="min-h-screen bg-[#0a0e1a]" />;
  }
  if (status === "anonymous") {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
