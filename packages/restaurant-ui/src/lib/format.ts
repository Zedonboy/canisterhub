/** Digits after the decimal point for `currency` (2 for USD/NGN, 0 for JPY).
 * Unknown/invalid currency codes fall back to 2 so nothing throws. */
export function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** `2500n` + "USD" -> "$25.00". Plain-text fallback when the currency code
 * isn't one Intl knows. */
export function formatMoney(minor: bigint, currency: string): string {
  const digits = minorDigits(currency);
  const value = Number(minor) / 10 ** digits;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${value.toFixed(digits)} ${currency}`;
  }
}

/** A price typed as "25.50" -> `2550n`. `null` when it isn't a non-negative
 * amount with at most the currency's decimal places. */
export function parseMoney(text: string, currency: string): bigint | null {
  const digits = minorDigits(currency);
  const match = text.trim().match(/^(\d+)(?:\.(\d*))?$/);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > digits) return null;
  return BigInt(match[1] + fraction.padEnd(digits, "0"));
}

/** `2550n` -> "25.50" for editing. */
export function minorToInput(minor: bigint, currency: string): string {
  const digits = minorDigits(currency);
  if (digits === 0) return minor.toString();
  const s = minor.toString().padStart(digits + 1, "0");
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

/** A whole number >= 0, or `null`. */
export function parseCount(text: string): bigint | null {
  return /^\d+$/.test(text.trim()) ? BigInt(text.trim()) : null;
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
