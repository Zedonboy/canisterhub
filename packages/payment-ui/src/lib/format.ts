// Amount/time rendering for the transaction log. The currency-exponent
// table deliberately mirrors `packages/kora-payment/src/lib.rs`'s
// `currency_exponent` - the canister validates amounts with exactly these
// exponents, so the UI's major-unit rendering must agree with it.

/** Minor-unit -> major-unit divisor, per the same currency table
 * `kora-payment` validates against (`currency_exponent` in its lib.rs). */
export function currencyExponent(currency: string): number | null {
  switch (currency.toUpperCase()) {
    case "JPY":
    case "KRW":
    case "XAF":
    case "XOF":
    case "UGX":
    case "RWF":
      return 0;
    case "BHD":
    case "IQD":
    case "JOD":
    case "KWD":
    case "LYD":
    case "OMR":
    case "TND":
      return 3;
    case "NGN":
    case "USD":
    case "EUR":
    case "GBP":
    case "KES":
    case "GHS":
    case "ZAR":
    case "TZS":
    case "EGP":
      return 2;
    default:
      // Unknown to the canister's table too - render raw minor units
      // rather than guessing a divisor.
      return null;
  }
}

export function formatAmount(amountMinor: bigint, currency: string): string {
  const code = currency.toUpperCase();
  const exponent = currencyExponent(code);
  if (exponent === null) return `${amountMinor} ${code} (minor units)`;
  if (exponent === 0) return `${amountMinor} ${code}`;
  const factor = 10n ** BigInt(exponent);
  const whole = amountMinor / factor;
  const fraction = (amountMinor % factor).toString().padStart(exponent, "0");
  return `${whole}.${fraction} ${code}`;
}

/** `created_at` on the wire is nanoseconds since the Unix epoch. */
export function formatTimestamp(ns: bigint): string {
  return new Date(Number(ns / 1_000_000n)).toLocaleString();
}

/** Short stable identity for a reference in tight table columns. */
export function shortRef(reference: string): string {
  return reference.length > 16 ? `${reference.slice(0, 8)}…${reference.slice(-6)}` : reference;
}
