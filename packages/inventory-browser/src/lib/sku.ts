// Random SKU suggestions, e.g. "SHI-7K3F9Q". Letters/digits that are easy to
// misread (0/O, 1/I/L) are left out so a SKU can be read over the phone.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function generateSku(name: string, kind: "Product" | "Service"): string {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
  const prefix = letters.length >= 2 ? letters : kind === "Service" ? "SVC" : "PRD";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const suffix = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${prefix}-${suffix}`;
}
