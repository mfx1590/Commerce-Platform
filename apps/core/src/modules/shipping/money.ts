// Carrier APIs quote decimal strings ("10.40"); every amount we store is an integer in minor units. The exponent
// is per currency: EUR/USD/GBP have two decimals, JPY none, TND three. Conversion is done on the string, never
// through a float, so 10.40 EUR can never become 1039.

/** Currencies whose minor unit is not 1/100. Extended as new markets are onboarded. */
const EXPONENTS: Record<string, number> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

/** Number of decimal places of a currency's minor unit (default 2). */
export function currencyExponent(currency: string): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2;
}

/**
 * `"10.40"`, `"10.4"`, `10.4` → 1040 for EUR. Rounds half away from zero at the currency's exponent (a carrier
 * quoting more decimals than the currency has is rounded, not truncated). Throws on anything that is not a
 * finite decimal number.
 */
export function toMinorUnits(amount: string | number, currency: string): number {
  const text = typeof amount === 'number' ? String(amount) : amount.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new RangeError(`not a decimal amount: ${JSON.stringify(amount)}`);
  }
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = text.replace(/^-/, '').split('.');
  const exponent = currencyExponent(currency);
  const padded = (fraction + '0'.repeat(exponent + 1)).slice(0, exponent + 1);
  const kept = padded.slice(0, exponent);
  const next = Number(padded.slice(exponent, exponent + 1));
  const base = Number(`${whole}${kept}` || '0');
  if (!Number.isFinite(base)) throw new RangeError(`amount out of range: ${text}`);
  const rounded = next >= 5 ? base + 1 : base;
  return negative ? -rounded : rounded;
}

/** 1040, EUR → `"10.40"`. The inverse of `toMinorUnits`; used when a provider wants a decimal string. */
export function fromMinorUnits(minor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const sign = minor < 0 ? '-' : '';
  const digits = String(Math.abs(Math.trunc(minor))).padStart(exponent + 1, '0');
  if (exponent === 0) return `${sign}${digits}`;
  return `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}
