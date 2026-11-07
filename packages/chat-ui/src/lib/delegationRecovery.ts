import { isEmbedded } from "./parentDelegation";

export const DELEGATION_RECOVERY_EVENT = "chat-ui:delegation-recovery-needed";

function errorDescription(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

export function isExpiredDelegationError(error: unknown): boolean {
  if (!isEmbedded()) return false;
  const text = errorDescription(error).toLowerCase();
  return /delegat(?:ion|ed identity).{0,80}(?:expir|too old|invalid|revok)|(?:expir|too old|invalid|revok).{0,80}delegat(?:ion|ed identity)/.test(text);
}

export function reportDelegationFailure(error: unknown): boolean {
  if (!isExpiredDelegationError(error)) return false;
  window.dispatchEvent(new Event(DELEGATION_RECOVERY_EVENT));
  return true;
}
