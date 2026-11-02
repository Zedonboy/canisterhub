/** Digits after the decimal point for `currency` (2 for USD/NGN, 0 for JPY). */
export function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** `250000n` + "NGN" -> "₦2,500.00". */
export function formatMoney(minor: bigint, currency: string): string {
  const digits = minorDigits(currency);
  const value = Number(minor) / 10 ** digits;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${value.toFixed(digits)} ${currency}`;
  }
}

/** "25.50" -> 2550n for a price filter box; null if it isn't a plain amount. */
export function parseMajor(text: string, currency: string): bigint | null {
  const m = text.trim().match(/^(\d+)(?:\.(\d*))?$/);
  if (!m) return null;
  const digits = minorDigits(currency);
  const frac = (m[2] ?? "").slice(0, digits).padEnd(digits, "0");
  return BigInt(m[1] + frac);
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
