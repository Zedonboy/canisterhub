// The customer's optional display name. It lives only in this browser
// (localStorage) and is sent along with each message so the business's inbox
// can label the conversation; the backend keeps just a copy for that label.
// It is self-declared, never proof of identity.
const KEY = "chat-display-name";
export const MAX_DISPLAY_NAME = 40;

export function loadDisplayName(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveDisplayName(raw: string): string {
  const name = Array.from(raw.replace(/\p{Cc}/gu, "").trim()).slice(0, MAX_DISPLAY_NAME).join("").trim();
  try {
    if (name) localStorage.setItem(KEY, name);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the name lasts for this visit only.
  }
  return name;
}
