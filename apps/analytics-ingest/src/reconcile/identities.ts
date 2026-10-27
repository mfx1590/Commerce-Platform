// The Integration 5 money identities (#602, D7 as amended 2026-10-25), each "0 difference in minor units":
//   1  bookings:  ClickHouse mart_bookings_daily = the core's getHqSalesReport (rpt_sales_daily), per store × day × currency
//   2a recognised, copy integrity: the ledger lines pulled into ClickHouse = what the Finance API served (per legal
//      entity × currency × day × account), and their period totals = the Finance API's own trial balance
//   2b recognised, lineage: every revenue line (4000/4010/4090) comes from a shipment.shipped / refund.issued in
//      raw_events, and every shipment.shipped in the window has ledger lines unless the ledger parked it
//   2c recognised, lifetime: per fully shipped, never cancelled, unrefunded order, Σ revenue on 4000 + 4010 = the
//      order's total − tax from order.placed (whatever the release rounding, remainder or VAT split)
//   3a cash: mart_cash_daily = the core's getHqFinanceReport (rpt_payments_daily), per store × day × currency
//   3b cash: captures in raw_events = the ledger's PSP-clearing debits (1100, source payment.captured), per legal
//      entity × currency × day
//   3c cash: the PSP's payouts (listPayouts) = the ledger's bank debits (1000, source psp.payout), per legal entity ×
//      currency
// No posting rule is implemented here: the ledger side is always the ledger's own lines or its own aggregates.
import type { ChClient } from '../clickhouse.js';
import type { AdminReportsClient, FinanceClient, JournalLine } from './clients.js';
import { addTo, compare, int, keyOf, listing, type IdentityResult, type Keyed } from './diff.js';

export interface ReconcileWindow {
  /** UTC days, `[from, to)`. */
  from: string;
  to: string;
  /** Only this store (bookings and cash reports); the ledger checks stay per legal entity. */
  storeId?: string | undefined;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertWindow(w: ReconcileWindow): void {
  if (!DAY.test(w.from) || !DAY.test(w.to) || w.to <= w.from)
    throw new RangeError('reconcile: --from and --to are YYYY-MM-DD with from < to');
  if (w.storeId !== undefined && !UUID.test(w.storeId))
    throw new RangeError('reconcile: --store must be a store uuid');
}

const REVENUE = ['4000', '4010', '4090'];

type Row = Record<string, string | number | null>;
async function q(ch: ChClient, sql: string): Promise<Row[]> {
  return (await ch.query({ query: sql, format: 'JSONEachRow' })).json<Row>();
}
const storeFilter = (w: ReconcileWindow, col = 'store_id') =>
  w.storeId ? ` AND ${col} = toUUID('${w.storeId}')` : '';

// ---- the ledger pull ---------------------------------------------------------------------------------------

export interface PulledLedger {
  legalEntities: string[];
  lines: JournalLine[];
}

/** Every journal line of every legal entity with books, in the window, copied into ClickHouse `ledger_lines`. */
export async function pullLedger(
  finance: FinanceClient,
  ch: ChClient,
  w: ReconcileWindow,
): Promise<PulledLedger> {
  const legalEntities = (await finance.legalEntities()).map((b) => b.legal_entity_id);
  const lines: JournalLine[] = [];
  for (const le of legalEntities) lines.push(...(await finance.journalLines(le, w.from, w.to)));
  for (let i = 0; i < lines.length; i += 5_000) {
    await ch.insert({
      table: 'ledger_lines',
      format: 'JSONEachRow',
      values: lines.slice(i, i + 5_000).map((l) => ({
        id: l.id,
        legal_entity_id: l.legal_entity_id,
        store_id: l.store_id,
        journal: l.journal,
        entry_date: l.entry_date,
        account_code: l.account_code,
        debit_minor: int(l.debit_minor, 'debit_minor'),
        credit_minor: int(l.credit_minor, 'credit_minor'),
        currency: l.currency,
        source_event_id: l.source_event_id,
        source_topic: l.source_topic,
        reference_type: l.reference_type,
        reference_id: l.reference_id,
      })),
    });
  }
  return { legalEntities, lines };
}

// ---- 1 bookings ------------------------------------------------------------------------------------------

const SALES_FIELDS = [
  'orders',
  'gross_minor',
  'discount_minor',
  'shipping_minor',
  'tax_minor',
  'total_minor',
  'refunded_minor',
  'net_minor',
] as const;

export async function checkBookings(
  ch: ChClient,
  admin: AdminReportsClient,
  w: ReconcileWindow,
): Promise<IdentityResult> {
  const left: Keyed = new Map();
  for (const r of await q(
    ch,
    `SELECT toString(store_id) AS store_id, toString(day) AS day, currency, ${SALES_FIELDS.join(', ')}
     FROM mart_bookings_daily WHERE day >= toDate('${w.from}') AND day < toDate('${w.to}')${storeFilter(w)}`,
  ))
    addTo(
      left,
      keyOf({ store: r.store_id, day: r.day, currency: r.currency }),
      figures(r, SALES_FIELDS),
    );
  const right: Keyed = new Map();
  for (const r of (await admin.sales(w.from, w.to)).rows as unknown as Row[]) {
    if (w.storeId && r.store_id !== w.storeId) continue;
    addTo(
      right,
      keyOf({ store: r.store_id, day: r.day, currency: r.currency }),
      figures(r, SALES_FIELDS),
    );
  }
  return compare(
    '1 bookings',
    { left: 'ClickHouse mart_bookings_daily', right: 'core getHqSalesReport' },
    left,
    right,
    SALES_FIELDS,
  );
}

function figures(r: Row, fields: readonly string[]): Record<string, number> {
  return Object.fromEntries(fields.map((f) => [f, int(r[f] ?? 0, f)]));
}

// ---- 2 recognised revenue --------------------------------------------------------------------------------

export async function checkCopyIntegrity(
  ch: ChClient,
  finance: FinanceClient,
  pulled: PulledLedger,
  w: ReconcileWindow,
): Promise<IdentityResult[]> {
  const fields = ['lines', 'debit_minor', 'credit_minor'];
  const served: Keyed = new Map();
  for (const l of pulled.lines)
    addTo(
      served,
      keyOf({
        le: l.legal_entity_id,
        currency: l.currency,
        day: l.entry_date,
        account: l.account_code,
      }),
      {
        lines: 1,
        debit_minor: int(l.debit_minor, 'debit_minor'),
        credit_minor: int(l.credit_minor, 'credit_minor'),
      },
    );
  const copied: Keyed = new Map();
  for (const r of await q(
    ch,
    `SELECT toString(legal_entity_id) AS le, currency, toString(entry_date) AS day, account_code,
            count() AS lines, sum(debit_minor) AS debit_minor, sum(credit_minor) AS credit_minor
     FROM fct_ledger_line WHERE entry_date >= toDate('${w.from}') AND entry_date < toDate('${w.to}')
     GROUP BY le, currency, day, account_code`,
  ))
    addTo(
      copied,
      keyOf({ le: r.le, currency: r.currency, day: r.day, account: r.account_code }),
      figures(r, fields),
    );
  const copy = compare(
    '2a recognised: copy integrity (lines)',
    { left: 'Finance API listJournalLines', right: 'ClickHouse fct_ledger_line' },
    served,
    copied,
    fields,
  );

  // the Finance API's own server-side aggregate, independent of the paging
  const tb: Keyed = new Map();
  for (const le of pulled.legalEntities)
    for (const r of (await finance.trialBalance(le, w.from, w.to)).rows)
      addTo(tb, keyOf({ le, currency: r.currency, account: r.account_code }), {
        debit_minor: int(r.debit_minor, 'debit_minor'),
        credit_minor: int(r.credit_minor, 'credit_minor'),
      });
  const chPeriod: Keyed = new Map();
  for (const r of await q(
    ch,
    `SELECT toString(legal_entity_id) AS le, currency, account_code,
            sum(debit_minor) AS debit_minor, sum(credit_minor) AS credit_minor
     FROM fct_ledger_line WHERE entry_date >= toDate('${w.from}') AND entry_date < toDate('${w.to}')
     GROUP BY le, currency, account_code`,
  ))
    addTo(
      chPeriod,
      keyOf({ le: r.le, currency: r.currency, account: r.account_code }),
      figures(r, ['debit_minor', 'credit_minor']),
    );
  const period = compare(
    '2a recognised: copy integrity (trial balance)',
    { left: 'Finance API getTrialBalance', right: 'ClickHouse fct_ledger_line' },
    tb,
    chPeriod,
    ['debit_minor', 'credit_minor'],
  );
  return [copy, period];
}

export async function checkLineage(
  ch: ChClient,
  finance: FinanceClient,
  pulled: PulledLedger,
  w: ReconcileWindow,
): Promise<IdentityResult> {
  const orphanLines = await q(
    ch,
    `SELECT toString(l.id) AS id, toString(l.source_event_id) AS source, l.source_topic AS topic
     FROM fct_ledger_line AS l
     WHERE l.is_revenue
       AND l.source_event_id NOT IN
           (SELECT event_id FROM raw_events FINAL WHERE topic IN ('shipment.shipped', 'refund.issued'))
       AND l.entry_date >= toDate('${w.from}') AND l.entry_date < toDate('${w.to}')`,
  );
  const parked = new Set<string>();
  for (const le of pulled.legalEntities)
    for (const p of await finance.parkedEvents(le)) parked.add(p.outbox_id);
  const unposted = (
    await q(
      ch,
      `SELECT toString(event_id) AS id FROM raw_events FINAL
       WHERE topic = 'shipment.shipped'
         AND occurred_at >= toDateTime64('${w.from} 00:00:00', 3, 'UTC')
         AND occurred_at < toDateTime64('${w.to} 00:00:00', 3, 'UTC')
         AND event_id NOT IN (SELECT source_event_id FROM fct_ledger_line)`,
    )
  ).filter((r) => !parked.has(String(r.id)));
  const [{ n } = { n: 0 }] = await q(
    ch,
    `SELECT count() AS n FROM fct_ledger_line WHERE is_revenue AND entry_date >= toDate('${w.from}') AND entry_date < toDate('${w.to}')`,
  );
  return listing(
    '2b recognised: lineage',
    { left: 'ledger revenue lines', right: 'raw_events shipment.shipped / refund.issued' },
    int(n, 'count') + unposted.length,
    [
      ...orphanLines.map((r) => ({
        key: keyOf({ line: r.id, source: r.source, topic: r.topic }),
        field: 'revenue line without its event in raw_events',
      })),
      ...unposted.map((r) => ({
        key: keyOf({ event: r.id }),
        field: 'shipment.shipped without ledger lines (and not parked)',
      })),
    ],
  );
}

export async function checkLifetime(ch: ChClient, w: ReconcileWindow): Promise<IdentityResult> {
  // fully shipped = every line's shipped quantity reaches its ordered quantity; never cancelled; no refund at all
  const rows = await q(
    ch,
    `WITH shipped AS (
        SELECT order_line_item_id, sum(quantity) AS q FROM fct_shipment_line GROUP BY order_line_item_id
     ),
     complete AS (
        SELECT l.order_id AS order_id
        FROM fct_order_line AS l
        LEFT JOIN shipped AS s ON s.order_line_item_id = l.order_line_item_id
        GROUP BY l.order_id
        HAVING countIf(s.q < l.quantity) = 0
     ),
     revenue AS (
        SELECT s.order_id AS order_id, sum(r.revenue_minor) AS revenue_minor
        FROM fct_ledger_line AS r
        INNER JOIN stg_shipment_shipped_v1 AS s ON s.event_id = r.source_event_id
        WHERE r.account_code IN ('4000', '4010')
        GROUP BY s.order_id
     )
     SELECT toString(o.order_id) AS order_id, o.currency AS currency,
            o.total_minor - o.tax_minor AS expected_minor, rv.revenue_minor AS revenue_minor
     FROM fct_order AS o
     INNER JOIN complete AS c ON c.order_id = o.order_id
     LEFT JOIN revenue AS rv ON rv.order_id = o.order_id
     WHERE o.order_status != 'cancelled'
       AND o.order_id NOT IN (SELECT order_id FROM fct_refund)
       AND o.placed_at >= toDateTime64('${w.from} 00:00:00', 3, 'UTC')
       AND o.placed_at < toDateTime64('${w.to} 00:00:00', 3, 'UTC')${storeFilter(w, 'o.store_id')}`,
  );
  const left: Keyed = new Map();
  const right: Keyed = new Map();
  for (const r of rows) {
    const key = keyOf({ order: r.order_id, currency: r.currency });
    left.set(key, { net_minor: int(r.expected_minor, 'expected_minor') });
    right.set(key, { net_minor: int(r.revenue_minor ?? 0, 'revenue_minor') });
  }
  return compare(
    '2c recognised: lifetime invariant',
    { left: 'order.placed total − tax', right: 'ledger 4000 + 4010' },
    left,
    right,
    ['net_minor'],
  );
}

// ---- 3 cash ----------------------------------------------------------------------------------------------

const CASH_FIELDS = ['captured_count', 'captured_minor', 'fee_minor', 'fee_unknown'] as const;

function* days(w: ReconcileWindow): Generator<[string, string]> {
  for (let d = new Date(`${w.from}T00:00:00Z`); d.toISOString().slice(0, 10) < w.to;) {
    const from = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
    yield [from, d.toISOString().slice(0, 10)];
  }
}

export async function checkCashReport(
  ch: ChClient,
  admin: AdminReportsClient,
  w: ReconcileWindow,
): Promise<IdentityResult> {
  const left: Keyed = new Map();
  for (const r of await q(
    ch,
    `SELECT toString(store_id) AS store_id, toString(day) AS day, currency, ${CASH_FIELDS.map((f) => `sum(${f}) AS ${f}`).join(', ')}
     FROM mart_cash_daily WHERE day >= toDate('${w.from}') AND day < toDate('${w.to}')${storeFilter(w)}
     GROUP BY store_id, day, currency`,
  ))
    addTo(
      left,
      keyOf({ store: r.store_id, day: r.day, currency: r.currency }),
      figures(r, CASH_FIELDS),
    );
  // the finance report has no day dimension: ask it one UTC day at a time
  const right: Keyed = new Map();
  for (const [from, to] of days(w))
    for (const r of (await admin.finance(from, to)).rows as unknown as Row[]) {
      if (w.storeId && r.store_id !== w.storeId) continue;
      if (int(r.captured_count, 'captured_count') === 0) continue;
      addTo(
        right,
        keyOf({ store: r.store_id, day: from, currency: r.currency }),
        figures(r, CASH_FIELDS),
      );
    }
  return compare(
    '3a cash: captures and fees',
    { left: 'ClickHouse mart_cash_daily', right: 'core getHqFinanceReport' },
    left,
    right,
    CASH_FIELDS,
  );
}

export async function checkCashLedger(
  ch: ChClient,
  finance: FinanceClient,
  pulled: PulledLedger,
  w: ReconcileWindow,
): Promise<IdentityResult[]> {
  const captured: Keyed = new Map();
  for (const r of await q(
    ch,
    `SELECT toString(legal_entity_id) AS le, currency, toString(toDate(captured_at, 'UTC')) AS day,
            sum(amount_minor) AS amount_minor
     FROM stg_payment_captured_v1
     WHERE captured_at >= toDateTime64('${w.from} 00:00:00', 3, 'UTC') AND captured_at < toDateTime64('${w.to} 00:00:00', 3, 'UTC')
     GROUP BY le, currency, day`,
  ))
    addTo(
      captured,
      keyOf({ le: r.le, currency: r.currency, day: r.day }),
      figures(r, ['amount_minor']),
    );
  const clearing: Keyed = new Map();
  for (const r of await q(
    ch,
    `SELECT toString(legal_entity_id) AS le, currency, toString(entry_date) AS day, sum(debit_minor) AS amount_minor
     FROM fct_ledger_line
     WHERE account_code = '1100' AND source_topic = 'payment.captured'
       AND entry_date >= toDate('${w.from}') AND entry_date < toDate('${w.to}')
     GROUP BY le, currency, day`,
  ))
    addTo(
      clearing,
      keyOf({ le: r.le, currency: r.currency, day: r.day }),
      figures(r, ['amount_minor']),
    );
  const psp = compare(
    '3b cash: captures = PSP clearing debits',
    { left: 'raw_events payment.captured', right: 'ledger 1100 debits (payment.captured)' },
    captured,
    clearing,
    ['amount_minor'],
  );

  const paid: Keyed = new Map();
  for (const le of pulled.legalEntities)
    for (const p of await finance.payouts(le, w.from, w.to))
      addTo(paid, keyOf({ le, currency: p.currency }), {
        amount_minor: int(p.amount_minor, 'amount_minor'),
      });
  const bank: Keyed = new Map();
  for (const r of await q(
    ch,
    `SELECT toString(legal_entity_id) AS le, currency, sum(debit_minor) AS amount_minor
     FROM fct_ledger_line
     WHERE account_code = '1000' AND source_topic = 'psp.payout'
       AND entry_date >= toDate('${w.from}') AND entry_date < toDate('${w.to}')
     GROUP BY le, currency`,
  ))
    addTo(bank, keyOf({ le: r.le, currency: r.currency }), figures(r, ['amount_minor']));
  const payouts = compare(
    '3c cash: payouts = bank debits',
    { left: 'Finance API listPayouts', right: 'ledger 1000 debits (psp.payout)' },
    paid,
    bank,
    ['amount_minor'],
  );
  return [psp, payouts];
}

export const REVENUE_ACCOUNTS = REVENUE;
