/**
 * Money is integer minor units everywhere in this platform (Memory-main global gotchas), and it
 * stays that way through the form layer: a text input's value is parsed to an integer by string
 * manipulation, never by multiplying a float. `12.10 * 100` is `1209.9999999999998`, and a cent
 * lost in a price list is a cent lost in the ledger.
 *
 * Pure: no React, no `next/*`.
 */

const DEFAULT_DIGITS = 2;

/** Minor-unit digits for a currency: 2 for EUR/GBP/USD, 0 for JPY, 3 for KWD. */
export function currencyDigits(currency: string): number {
  try {
    const format = new Intl.NumberFormat('en', { style: 'currency', currency });
    return format.resolvedOptions().maximumFractionDigits ?? DEFAULT_DIGITS;
  } catch {
    // Unknown or malformed code: the field's own validation reports it; assume the common case.
    return DEFAULT_DIGITS;
  }
}

export interface MoneyParseError {
  ok: false;
  reason: 'empty' | 'not_a_number' | 'too_many_decimals' | 'negative';
}

export type MoneyParseResult = { ok: true; amountMinor: number } | MoneyParseError;

/**
 * Parses what a person typed into integer minor units.
 *
 * Accepts an optional sign, digits, and either separator as the decimal point — a German keyboard
 * types `12,50` and meaning it as 1250 is the only sensible reading. Group separators are rejected
 * rather than guessed at: `1,234` is genuinely ambiguous between 1234 and 1.234.
 */
export function parseMoney(
  input: string,
  currency: string,
  options: { allowNegative?: boolean } = {},
): MoneyParseResult {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };

  const match = /^(-?)(\d*)(?:[.,](\d*))?$/.exec(trimmed);
  if (match === null) return { ok: false, reason: 'not_a_number' };

  const [, sign = '', whole = '', fraction] = match;
  if (whole === '' && (fraction === undefined || fraction === '')) {
    return { ok: false, reason: 'not_a_number' };
  }
  if (sign === '-' && options.allowNegative !== true) {
    return { ok: false, reason: 'negative' };
  }

  const digits = currencyDigits(currency);
  const typed = fraction ?? '';
  if (typed.length > digits) return { ok: false, reason: 'too_many_decimals' };

  const padded = typed.padEnd(digits, '0');
  const amountMinor = Number.parseInt(`${whole === '' ? '0' : whole}${padded}`, 10);
  if (!Number.isSafeInteger(amountMinor)) return { ok: false, reason: 'not_a_number' };

  return { ok: true, amountMinor: sign === '-' ? -amountMinor : amountMinor };
}

/** Minor units back to a plain editable string — no grouping, so it round-trips through the input. */
export function formatMoneyInput(amountMinor: number, currency: string): string {
  const digits = currencyDigits(currency);
  const sign = amountMinor < 0 ? '-' : '';
  const absolute = Math.abs(amountMinor)
    .toString()
    .padStart(digits + 1, '0');
  if (digits === 0) return `${sign}${absolute}`;
  return `${sign}${absolute.slice(0, -digits)}.${absolute.slice(-digits)}`;
}

/** Display formatting with the currency symbol, for read-only cells and summaries. */
export function formatMoney(amountMinor: number, currency: string, locale = 'en-GB'): string {
  const digits = currencyDigits(currency);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(
      amountMinor / 10 ** digits,
    );
  } catch {
    return `${formatMoneyInput(amountMinor, currency)} ${currency}`;
  }
}

export function moneyErrorMessage(reason: MoneyParseError['reason'], currency: string): string {
  switch (reason) {
    case 'empty':
      return 'Enter an amount';
    case 'too_many_decimals': {
      const digits = currencyDigits(currency);
      return digits === 0
        ? `${currency} amounts have no decimal places`
        : `${currency} amounts have at most ${digits} decimal places`;
    }
    case 'negative':
      return 'Enter a positive amount';
    default:
      return 'Enter a valid amount';
  }
}
