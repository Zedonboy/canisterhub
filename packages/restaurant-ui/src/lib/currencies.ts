// Currency choices for the item form: every ISO code the browser knows, with
// its English name, plus a short list of common ones pinned to the top.
const COMMON = ["USD", "EUR", "GBP", "NGN", "GHS", "KES", "ZAR", "CAD", "AUD", "INR", "JPY", "CNY"];

export interface CurrencyOption {
  code: string;
  label: string;
}

function allCodes(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("currency");
    if (supported?.length) return supported;
  } catch {
    // fall through to the common list
  }
  return COMMON;
}

function nameOf(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** `current` is always included, even if it isn't a recognised ISO code
 * (e.g. a custom code saved earlier), so editing never silently changes it. */
export function currencyOptions(current: string): CurrencyOption[] {
  const codes = new Set<string>(allCodes());
  for (const c of COMMON) codes.add(c);
  if (current) codes.add(current);
  const option = (code: string): CurrencyOption => ({ code, label: `${code} - ${nameOf(code)}` });
  const rest = [...codes].filter((c) => !COMMON.includes(c) && c !== current).sort();
  const head = COMMON.includes(current) || !current ? COMMON : [current, ...COMMON];
  return [...head, ...rest].map(option);
}
