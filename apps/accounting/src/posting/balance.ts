// Arithmetic and invariants shared by the posting functions: integer proportions, line construction, aggregation
// per account (the UNIQUE (source_event_id, account_code) guard means one row per account per event), and the
// balance check every entry passes before anything is written.
import type { AccountCode } from '../chart.js';
import { AccountCollisionError, UnbalancedEntryError } from '../errors.js';
import type { JournalEntry, JournalLine } from './types.js';

export type Side = 'debit' | 'credit';

/**
 * A line of `amount` on `side`; a negative amount lands on the other side; zero is no line. Keeps every posting
 * function free of sign juggling (a negative "shipping net" from an odd rounding still balances).
 */
export function line(
  account_code: AccountCode,
  currency: string,
  amount: number,
  side: Side,
): JournalLine | null {
  if (!Number.isSafeInteger(amount))
    throw new TypeError(`amount must be an integer, got ${amount}`);
  if (amount === 0) return null;
  const debit = (side === 'debit') === amount > 0;
  const abs = Math.abs(amount);
  return {
    account_code,
    currency,
    debit_minor: debit ? abs : 0,
    credit_minor: debit ? 0 : abs,
  };
}

/** floor(amount × num / den) in exact integer arithmetic (BigInt), the rule for cumulative releases. */
export function proportion(amount: number, num: number, den: number): number {
  if (den <= 0) throw new RangeError(`denominator must be positive, got ${den}`);
  if (num < 0) throw new RangeError(`numerator must not be negative, got ${num}`);
  const q = (BigInt(amount) * BigInt(num)) / BigInt(den);
  return Number(q);
}

/** round-half-up(amount × num / den): the proportional VAT share of a refund or a cancellation. */
export function roundShare(amount: number, num: number, den: number): number {
  if (den <= 0) throw new RangeError(`denominator must be positive, got ${den}`);
  if (num < 0) throw new RangeError(`numerator must not be negative, got ${num}`);
  const twice = BigInt(amount) * BigInt(num) * 2n + BigInt(den);
  return Number(twice / (2n * BigInt(den)));
}

/**
 * A timestamp as an instant (ms since the epoch). The events contract only promises `format: date-time`, so two
 * strings for the same moment may differ (`09:00:00Z` / `09:00:00.000Z` / `11:00:00+02:00`) and string order is not
 * time order: every comparison of event times goes through this (#589).
 */
export function instantOf(timestamp: string): number {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) throw new TypeError(`not a timestamp: ${timestamp}`);
  return ms;
}

/** The UTC calendar date of an RFC-3339 timestamp. */
export function dateOf(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) throw new TypeError(`not a timestamp: ${timestamp}`);
  return d.toISOString().slice(0, 10);
}

/** Nets the lines per (account, currency) into one debit or one credit each; drops what nets to zero. */
export function aggregateLines(lines: (JournalLine | null)[]): JournalLine[] {
  const net = new Map<string, { account_code: AccountCode; currency: string; amount: number }>();
  for (const l of lines) {
    if (!l) continue;
    const key = `${l.account_code}:${l.currency}`;
    const cur = net.get(key) ?? { account_code: l.account_code, currency: l.currency, amount: 0 };
    cur.amount += l.debit_minor - l.credit_minor;
    net.set(key, cur);
  }
  const out: JournalLine[] = [];
  for (const { account_code, currency, amount } of net.values()) {
    const l = line(account_code, currency, amount, 'debit');
    if (l) out.push(l);
  }
  return out.sort((a, b) =>
    a.currency === b.currency
      ? a.account_code.localeCompare(b.account_code)
      : a.currency.localeCompare(b.currency),
  );
}

export function assertBalanced(entry: JournalEntry): void {
  const sums = new Map<string, { debit: number; credit: number }>();
  for (const l of entry.lines) {
    const s = sums.get(l.currency) ?? { debit: 0, credit: 0 };
    s.debit += l.debit_minor;
    s.credit += l.credit_minor;
    sums.set(l.currency, s);
  }
  for (const [currency, s] of sums) {
    if (s.debit !== s.credit)
      throw new UnbalancedEntryError(entry.source_event_id, currency, s.debit, s.credit);
  }
}

/** Aggregates and checks one entry. Every posting function returns its entries through this. */
export function finalizeEntry(
  entry: Omit<JournalEntry, 'lines'> & { lines: (JournalLine | null)[] },
): JournalEntry {
  const out: JournalEntry = { ...entry, lines: aggregateLines(entry.lines) };
  assertBalanced(out);
  return out;
}

/**
 * The entries of ONE event must not post the same account twice (one ledger_entry row per (event, account)); drops
 * entries that have no lines (a fully discounted, free-shipping order posts nothing at placement).
 */
export function finalizeEntries(entries: JournalEntry[]): JournalEntry[] {
  const seen = new Set<string>();
  const kept: JournalEntry[] = [];
  for (const e of entries) {
    if (e.lines.length === 0) continue;
    for (const l of e.lines) {
      if (seen.has(l.account_code))
        throw new AccountCollisionError(e.source_event_id, l.account_code);
      seen.add(l.account_code);
    }
    kept.push(e);
  }
  return kept;
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
