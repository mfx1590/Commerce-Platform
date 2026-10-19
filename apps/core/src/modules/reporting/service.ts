// Reporting v1 (#479): the four Admin API reports, read from the 0200 views through the caller's scoped client.
// RLS (security_invoker views) decides which stores a client sees; the store reports also filter on the one store
// explicitly (manager decision Q4). Amounts are integer minor units and are never summed across currencies: every
// total is keyed by currency.
import type { ScopedClient } from '@platform/db';
import { notFound, validationError } from '../../lib/errors';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_DAYS = 366;
const MS_PER_DAY = 86_400_000;

export const REFUND_REASONS = ['return', 'cancellation', 'goodwill', 'chargeback'] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export interface ReportQuery {
  from?: string;
  to?: string;
  currency?: string;
}

export interface ReportWindow {
  from: string;
  to: string;
  currency?: string;
}

const SALES_FIGURES = [
  'orders',
  'gross_minor',
  'discount_minor',
  'shipping_minor',
  'tax_minor',
  'total_minor',
  'refunded_minor',
  'net_minor',
] as const;
type SalesFigures = Record<(typeof SALES_FIGURES)[number], number>;

export type SalesRow = SalesFigures & { store_id: string; day: string; currency: string };
export type SalesTotal = SalesFigures & { store_id: string; currency: string };
export type SalesCurrencyTotal = SalesFigures & { currency: string };

export interface SalesReport {
  from: string;
  to: string;
  generated_at: string;
  rows: SalesRow[];
  totals: SalesTotal[];
  currency_totals: SalesCurrencyTotal[];
}

export interface StockPosition {
  stock_item_id: string;
  sku: string;
  warehouse_id: string;
  warehouse_code: string;
  on_hand: number;
  reserved: number;
  incoming: number;
  available: number;
}

export interface StockReport {
  page: number;
  limit: number;
  total: number;
  generated_at: string;
  items: StockPosition[];
}

interface FinanceFigures {
  captured_count: number;
  captured_minor: number;
  fee_minor: number;
  fee_unknown: number;
  refunds: number;
  refunded_minor: number;
  refunded_by_reason: Record<RefundReason, number>;
}
export type FinanceRow = FinanceFigures & { store_id: string; currency: string };
export type FinanceCurrencyTotal = FinanceFigures & { currency: string };

export interface FinanceReport {
  from: string;
  to: string;
  generated_at: string;
  fees_reconciled: false;
  rows: FinanceRow[];
  currency_totals: FinanceCurrencyTotal[];
}

/** A real calendar day `YYYY-MM-DD`, as UTC midnight in ms (NaN otherwise). */
function dayMs(value: string): number {
  if (!DAY.test(value)) return NaN;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value ? t : NaN;
}

/** `from` inclusive, `to` exclusive, UTC days, at most 366 days; optional currency. 400 `validation_error`. */
export function parseReportWindow(query: ReportQuery): ReportWindow {
  const problems: Record<string, string> = {};
  const from = query.from ?? '';
  const to = query.to ?? '';
  const f = dayMs(from);
  const t = dayMs(to);
  if (Number.isNaN(f)) problems.from = 'date (YYYY-MM-DD)';
  if (Number.isNaN(t)) problems.to = 'date (YYYY-MM-DD)';
  if (!Number.isNaN(f) && !Number.isNaN(t)) {
    if (t <= f) problems.to = 'must be after from';
    else if ((t - f) / MS_PER_DAY > MAX_DAYS) problems.to = `at most ${MAX_DAYS} days after from`;
  }
  const currency = query.currency === '' ? undefined : query.currency;
  if (currency !== undefined && !CURRENCY.test(currency)) problems.currency = 'ISO 4217 code';
  if (Object.keys(problems).length) throw validationError('invalid report window', problems);
  return { from, to, ...(currency ? { currency } : {}) };
}

/** A bigint column (node-postgres returns it as text) as a JS integer; refuses values beyond 2^53. */
function int(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? 0));
  if (!Number.isSafeInteger(n)) throw new Error(`reporting: ${String(v)} is not a safe integer`);
  return n;
}

async function assertStore(client: ScopedClient, storeId: string): Promise<void> {
  const { rows } = await client.query(`SELECT 1 FROM store WHERE id = $1`, [storeId]);
  if (rows.length === 0) throw notFound('store', storeId);
}

function zeroSales(): SalesFigures {
  return Object.fromEntries(SALES_FIGURES.map((k) => [k, 0])) as SalesFigures;
}

function addSales(into: SalesFigures, row: SalesFigures): void {
  for (const k of SALES_FIGURES) into[k] = int(into[k] + row[k]);
}

/** Totals keyed by `key(row)`; each group's amounts are of one currency by construction (currency is in the key). */
function totalsBy<T extends SalesRow, K extends object>(
  rows: T[],
  key: (r: T) => K,
): (K & SalesFigures)[] {
  const out = new Map<string, K & SalesFigures>();
  for (const r of rows) {
    const k = key(r);
    const id = JSON.stringify(k);
    let acc = out.get(id);
    if (!acc) {
      acc = { ...k, ...zeroSales() };
      out.set(id, acc);
    }
    addSales(acc, r);
  }
  return [...out.values()];
}

async function salesReport(
  client: ScopedClient,
  window: ReportWindow,
  storeId?: string,
): Promise<SalesReport> {
  const params: unknown[] = [window.from, window.to];
  let where = `day >= $1::date AND day < $2::date`;
  if (storeId) {
    params.push(storeId);
    where += ` AND store_id = $${params.length}`;
  }
  if (window.currency) {
    params.push(window.currency);
    where += ` AND currency = $${params.length}`;
  }
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT store_id, day::text AS day, currency, ${SALES_FIGURES.join(', ')}
       FROM rpt_sales_daily
      WHERE ${where}
      ORDER BY day, store_id, currency`,
    params,
  );
  const out: SalesRow[] = rows.map((r) => ({
    store_id: String(r.store_id),
    day: String(r.day),
    currency: String(r.currency).trim(),
    ...(Object.fromEntries(SALES_FIGURES.map((k) => [k, int(r[k])])) as SalesFigures),
  }));
  return {
    from: window.from,
    to: window.to,
    generated_at: new Date().toISOString(),
    rows: out,
    totals: totalsBy(out, (r) => ({ store_id: r.store_id, currency: r.currency })),
    currency_totals: totalsBy(out, (r) => ({ currency: r.currency })),
  };
}

/** `getStoreSalesReport`: `client` must be scoped to `storeId` alone (`storeClientFor`). */
export async function storeSalesReport(
  client: ScopedClient,
  storeId: string,
  query: ReportQuery,
): Promise<SalesReport> {
  const window = parseReportWindow(query);
  await assertStore(client, storeId);
  return salesReport(client, window, storeId);
}

/** `getHqSalesReport`: organization scope, every store. */
export async function hqSalesReport(
  client: ScopedClient,
  query: ReportQuery,
): Promise<SalesReport> {
  return salesReport(client, parseReportWindow(query));
}

/**
 * `getStoreStockReport`: the pool rows the store sells from. The view has no store column; the store-scoped client's
 * RLS (`pool`) already limits it to items the store maps, and the EXISTS repeats that for this one store.
 */
export async function storeStockReport(
  client: ScopedClient,
  storeId: string,
  paging: { page: number; limit: number },
): Promise<StockReport> {
  await assertStore(client, storeId);
  const fence = `EXISTS (SELECT 1 FROM product_variant v WHERE v.store_id = $1 AND v.stock_item_id = s.stock_item_id)`;
  const [count, page] = await Promise.all([
    client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM rpt_stock_position s WHERE ${fence}`,
      [storeId],
    ),
    client.query<Record<string, unknown>>(
      `SELECT s.stock_item_id, s.sku, s.warehouse_id, s.warehouse_code, s.on_hand, s.reserved, s.incoming, s.available
         FROM rpt_stock_position s
        WHERE ${fence}
        ORDER BY s.sku, s.warehouse_code
        LIMIT $2 OFFSET $3`,
      [storeId, paging.limit, (paging.page - 1) * paging.limit],
    ),
  ]);
  return {
    page: paging.page,
    limit: paging.limit,
    total: int(count.rows[0]?.n),
    generated_at: new Date().toISOString(),
    items: page.rows.map((r) => ({
      stock_item_id: String(r.stock_item_id),
      sku: String(r.sku),
      warehouse_id: String(r.warehouse_id),
      warehouse_code: String(r.warehouse_code),
      on_hand: int(r.on_hand),
      reserved: int(r.reserved),
      incoming: int(r.incoming),
      available: int(r.available),
    })),
  };
}

function zeroFinance(): FinanceFigures {
  return {
    captured_count: 0,
    captured_minor: 0,
    fee_minor: 0,
    fee_unknown: 0,
    refunds: 0,
    refunded_minor: 0,
    refunded_by_reason: { return: 0, cancellation: 0, goodwill: 0, chargeback: 0 },
  };
}

function addFinance(into: FinanceFigures, f: FinanceFigures): void {
  into.captured_count = int(into.captured_count + f.captured_count);
  into.captured_minor = int(into.captured_minor + f.captured_minor);
  into.fee_minor = int(into.fee_minor + f.fee_minor);
  into.fee_unknown = int(into.fee_unknown + f.fee_unknown);
  into.refunds = int(into.refunds + f.refunds);
  into.refunded_minor = int(into.refunded_minor + f.refunded_minor);
  for (const r of REFUND_REASONS) {
    into.refunded_by_reason[r] = int(into.refunded_by_reason[r] + f.refunded_by_reason[r]);
  }
}

/** `getHqFinanceReport`: cash view, payments by capture day and refunds by refund day, per store and currency. */
export async function hqFinanceReport(
  client: ScopedClient,
  query: ReportQuery,
): Promise<FinanceReport> {
  const window = parseReportWindow(query);
  const params: unknown[] = [window.from, window.to];
  let where = `day >= $1::date AND day < $2::date`;
  if (window.currency) {
    params.push(window.currency);
    where += ` AND currency = $3`;
  }
  const [payments, refunds] = await Promise.all([
    client.query<Record<string, unknown>>(
      `SELECT store_id, currency, sum(captured_count)::bigint AS captured_count,
              sum(captured_minor)::bigint AS captured_minor, sum(fee_minor)::bigint AS fee_minor,
              sum(fee_unknown)::bigint AS fee_unknown
         FROM rpt_payments_daily WHERE ${where} GROUP BY store_id, currency`,
      params,
    ),
    client.query<Record<string, unknown>>(
      `SELECT store_id, currency, reason, sum(refunds)::bigint AS refunds,
              sum(refunded_minor)::bigint AS refunded_minor
         FROM rpt_refunds_daily WHERE ${where} GROUP BY store_id, currency, reason`,
      params,
    ),
  ]);

  const rows = new Map<string, FinanceRow>();
  const row = (storeId: unknown, currency: unknown): FinanceRow => {
    const k = `${String(storeId)}|${String(currency).trim()}`;
    let r = rows.get(k);
    if (!r) {
      r = { store_id: String(storeId), currency: String(currency).trim(), ...zeroFinance() };
      rows.set(k, r);
    }
    return r;
  };
  for (const p of payments.rows) {
    const r = row(p.store_id, p.currency);
    r.captured_count = int(p.captured_count);
    r.captured_minor = int(p.captured_minor);
    r.fee_minor = int(p.fee_minor);
    r.fee_unknown = int(p.fee_unknown);
  }
  for (const f of refunds.rows) {
    const r = row(f.store_id, f.currency);
    const reason = String(f.reason);
    r.refunds = int(r.refunds + int(f.refunds));
    r.refunded_minor = int(r.refunded_minor + int(f.refunded_minor));
    if ((REFUND_REASONS as readonly string[]).includes(reason)) {
      r.refunded_by_reason[reason as RefundReason] = int(f.refunded_minor);
    }
  }
  const list = [...rows.values()].sort(
    (a, b) => a.store_id.localeCompare(b.store_id) || a.currency.localeCompare(b.currency),
  );
  const totals = new Map<string, FinanceCurrencyTotal>();
  for (const r of list) {
    let t = totals.get(r.currency);
    if (!t) {
      t = { currency: r.currency, ...zeroFinance() };
      totals.set(r.currency, t);
    }
    addFinance(t, r);
  }
  return {
    from: window.from,
    to: window.to,
    generated_at: new Date().toISOString(),
    fees_reconciled: false,
    rows: list,
    currency_totals: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}
