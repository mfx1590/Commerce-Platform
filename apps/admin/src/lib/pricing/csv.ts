/**
 * CSV import for a price list: text in, per-row verdicts out, nothing sent.
 *
 * Columns: `sku` or `variant_id`, `amount`, then optionally `compare_at` and `min_quantity`. A
 * header row is recognised by its names and skipped; without one, that order is assumed. Amounts
 * are parsed with `parseMoney` — string arithmetic, never a float — so `12.345` in EUR (three
 * decimals) or `12.5` in JPY (zero) is a rejected row, as is anything that is not a number, a
 * negative amount, a compare-at below the amount, or a SKU the loaded products do not know.
 *
 * Pure: the screen renders the preview from the rows and submits only the `ok` ones; the server
 * action then re-validates that batch again (`priceUpsertBatchSchema`), so a row rejected here
 * cannot reach the API through a manipulated request either.
 */

import { parseMoney } from '../forms/money';

export interface CsvPrice {
  variant_id: string;
  amount_minor: number;
  compare_at_minor: number | null;
  min_quantity: number;
}

export type CsvRow =
  | { line: number; raw: string; verdict: 'ok'; price: CsvPrice; label: string }
  | { line: number; raw: string; verdict: 'error'; message: string };

export interface CsvResolution {
  /** SKU → variant id, from the products the editor has loaded. */
  bySku: ReadonlyMap<string, { variantId: string; label: string }>;
  /** variant id → label, for rows that name the id directly. */
  byVariantId: ReadonlyMap<string, string>;
  currency: string;
}

const HEADER_NAMES = new Set(['sku', 'variant_id', 'amount', 'compare_at', 'min_quantity']);

function splitLine(line: string): string[] {
  // Comma or semicolon separated, optional double quotes, no embedded separators inside quotes
  // needed for this data (SKUs and numbers).
  const separator = line.includes(';') && !line.includes(',') ? ';' : ',';
  return line.split(separator).map((cell) => cell.trim().replace(/^"(.*)"$/, '$1'));
}

function parseAmount(text: string, currency: string, label: string): number | string {
  const result = parseMoney(text, currency);
  if (result.ok) return result.amountMinor;
  switch (result.reason) {
    case 'empty':
      return `${label}: empty`;
    case 'too_many_decimals':
      return `${label}: not a whole number of minor units for ${currency}`;
    default:
      return `${label}: not a number`;
  }
}

export function parsePriceCsv(text: string, resolution: CsvResolution): CsvRow[] {
  const rows: CsvRow[] = [];
  const lines = text.split(/\r?\n/);
  let columns: string[] = ['id', 'amount', 'compare_at', 'min_quantity'];

  lines.forEach((rawLine, index) => {
    const raw = rawLine.trim();
    const line = index + 1;
    if (raw === '' || raw.startsWith('#')) return;
    const cells = splitLine(raw);

    if (index === 0 && cells.some((cell) => HEADER_NAMES.has(cell.toLowerCase()))) {
      columns = cells.map((cell) => {
        const name = cell.toLowerCase();
        return name === 'sku' || name === 'variant_id' ? 'id' : name;
      });
      return;
    }

    const cell = (name: string) => {
      const at = columns.indexOf(name);
      return at < 0 ? undefined : cells[at];
    };

    const id = cell('id') ?? '';
    if (id === '') {
      rows.push({ line, raw, verdict: 'error', message: 'No SKU or variant id' });
      return;
    }
    const resolved =
      resolution.bySku.get(id) ??
      (resolution.byVariantId.has(id)
        ? { variantId: id, label: resolution.byVariantId.get(id) ?? id }
        : undefined);
    if (resolved === undefined) {
      rows.push({ line, raw, verdict: 'error', message: `Unknown SKU or variant: ${id}` });
      return;
    }

    const amount = parseAmount(cell('amount') ?? '', resolution.currency, 'amount');
    if (typeof amount === 'string') {
      rows.push({ line, raw, verdict: 'error', message: amount });
      return;
    }

    const compareText = cell('compare_at') ?? '';
    let compare: number | null = null;
    if (compareText !== '') {
      const parsed = parseAmount(compareText, resolution.currency, 'compare_at');
      if (typeof parsed === 'string') {
        rows.push({ line, raw, verdict: 'error', message: parsed });
        return;
      }
      if (parsed < amount) {
        rows.push({ line, raw, verdict: 'error', message: 'compare_at is below the amount' });
        return;
      }
      compare = parsed;
    }

    const minText = cell('min_quantity') ?? '';
    let minQuantity = 1;
    if (minText !== '') {
      if (!/^\d+$/.test(minText) || Number(minText) < 1) {
        rows.push({ line, raw, verdict: 'error', message: 'min_quantity: a whole number ≥ 1' });
        return;
      }
      minQuantity = Number(minText);
    }

    rows.push({
      line,
      raw,
      verdict: 'ok',
      label: resolved.label,
      price: {
        variant_id: resolved.variantId,
        amount_minor: amount,
        compare_at_minor: compare,
        min_quantity: minQuantity,
      },
    });
  });

  return rows;
}

export function csvSummary(rows: readonly CsvRow[]): { ok: number; errors: number } {
  return {
    ok: rows.filter((row) => row.verdict === 'ok').length,
    errors: rows.filter((row) => row.verdict === 'error').length,
  };
}

/** Exactly the rows the preview marked `ok`, as the upsert body expects them. */
export function acceptedPrices(rows: readonly CsvRow[]): CsvPrice[] {
  return rows.flatMap((row) => (row.verdict === 'ok' ? [row.price] : []));
}
