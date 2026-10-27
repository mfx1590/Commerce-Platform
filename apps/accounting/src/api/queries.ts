// The read API's queries (#551) on the organization-scoped client. Read-only by construction: SELECTs only. Money
// stays integer minor; every row carries its currency; nothing is summed across currencies.
import type { Queryable } from '@platform/db';

export interface PageQuery {
  page: number;
  limit: number;
}

export interface PeriodQuery {
  from?: string;
  to?: string;
}

const n = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : Number(v);
/**
 * A `date` column, already text. node-postgres parses `date` as LOCAL midnight, so formatting a Date served every
 * day one day early east of UTC (#627). Every date column is selected `::text` (`YYYY-MM-DD`, no time zone
 * anywhere); a Date reaching this function is a query that forgot the cast, and it fails loudly instead of shifting.
 */
const date = (v: string | null): string | null => {
  if (v !== null && typeof v !== 'string')
    throw new TypeError('a date column must be selected ::text (#627)');
  return v;
};
const ts = (v: Date | null): string | null => (v === null ? null : v.toISOString());

/** The legal entity exists in the caller's organization (RLS decides what "exists" means). */
export async function legalEntityExists(q: Queryable, legalEntityId: string): Promise<boolean> {
  const r = await q.query('SELECT 1 FROM legal_entity WHERE id = $1', [legalEntityId]);
  return r.rows.length > 0;
}

export async function listLegalEntityBooks(q: Queryable) {
  const r = await q.query<{
    legal_entity_id: string;
    code: string;
    name: string;
    reporting_currency: string;
    currencies: string[] | null;
    entries: string;
    unposted_entries: string;
    first_entry_date: string | null;
    last_entry_date: string | null;
    odoo_company_id: number | null;
  }>(
    `SELECT le.id AS legal_entity_id, le.code, le.name, le.currency AS reporting_currency, le.odoo_company_id,
            (SELECT array_agg(DISTINCT e.currency ORDER BY e.currency) FROM ledger_entry e WHERE e.legal_entity_id = le.id) AS currencies,
            (SELECT count(*)::text FROM ledger_entry e WHERE e.legal_entity_id = le.id) AS entries,
            (SELECT count(*)::text FROM ledger_entry e WHERE e.legal_entity_id = le.id AND e.posted_to_erp_at IS NULL) AS unposted_entries,
            (SELECT min(e.entry_date)::text FROM ledger_entry e WHERE e.legal_entity_id = le.id) AS first_entry_date,
            (SELECT max(e.entry_date)::text FROM ledger_entry e WHERE e.legal_entity_id = le.id) AS last_entry_date
       FROM legal_entity le ORDER BY le.code`,
  );
  return r.rows.map((row) => ({
    legal_entity_id: row.legal_entity_id,
    code: row.code,
    name: row.name,
    reporting_currency: row.reporting_currency,
    currencies: row.currencies ?? [],
    entries: n(row.entries),
    unposted_entries: n(row.unposted_entries),
    first_entry_date: date(row.first_entry_date),
    last_entry_date: date(row.last_entry_date),
    odoo_company_id: row.odoo_company_id,
  }));
}

export async function trialBalance(
  q: Queryable,
  legalEntityId: string,
  period: PeriodQuery & { currency?: string },
) {
  const r = await q.query<{
    currency: string;
    account_code: string;
    account_name: string | null;
    account_type: string | null;
    debit: string;
    credit: string;
  }>(
    `SELECT e.currency, e.account_code, a.name AS account_name, a.type AS account_type,
            sum(e.debit_minor)::text AS debit, sum(e.credit_minor)::text AS credit
       FROM ledger_entry e
       LEFT JOIN ledger_account a ON a.legal_entity_id = e.legal_entity_id AND a.code = e.account_code
      WHERE e.legal_entity_id = $1
        AND ($2::date IS NULL OR e.entry_date >= $2::date)
        AND ($3::date IS NULL OR e.entry_date <= $3::date)
        AND ($4::text IS NULL OR e.currency = $4)
      GROUP BY e.currency, e.account_code, a.name, a.type
      ORDER BY e.currency, e.account_code`,
    [legalEntityId, period.from ?? null, period.to ?? null, period.currency ?? null],
  );
  const rows = r.rows.map((row) => ({
    currency: row.currency,
    account_code: row.account_code,
    account_name: row.account_name ?? row.account_code,
    account_type: row.account_type ?? 'asset',
    debit_minor: n(row.debit),
    credit_minor: n(row.credit),
    balance_minor: n(row.debit) - n(row.credit),
  }));
  const totals = new Map<
    string,
    { currency: string; debit_minor: number; credit_minor: number; difference_minor: number }
  >();
  for (const row of rows) {
    const t = totals.get(row.currency) ?? {
      currency: row.currency,
      debit_minor: 0,
      credit_minor: 0,
      difference_minor: 0,
    };
    t.debit_minor += row.debit_minor;
    t.credit_minor += row.credit_minor;
    t.difference_minor = t.debit_minor - t.credit_minor;
    totals.set(row.currency, t);
  }
  return {
    legal_entity_id: legalEntityId,
    from: period.from ?? null,
    to: period.to ?? null,
    rows,
    totals: [...totals.values()],
  };
}

export interface JournalLinesFilter extends PeriodQuery, PageQuery {
  currency?: string;
  journal?: string;
  account_code?: string;
  reference_type?: string;
  reference_id?: string;
  source_event_id?: string;
  erp?: 'posted' | 'unposted';
}

export async function listJournalLines(q: Queryable, legalEntityId: string, f: JournalLinesFilter) {
  const where = ['e.legal_entity_id = $1'];
  const params: unknown[] = [legalEntityId];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (f.from) add('e.entry_date >= ?::date', f.from);
  if (f.to) add('e.entry_date <= ?::date', f.to);
  if (f.currency) add('e.currency = ?', f.currency);
  if (f.journal) add('e.journal = ?', f.journal);
  if (f.account_code) add('e.account_code = ?', f.account_code);
  if (f.reference_type) add('e.reference_type = ?', f.reference_type);
  if (f.reference_id) add('e.reference_id = ?::uuid', f.reference_id);
  if (f.source_event_id) add('e.source_event_id = ?::uuid', f.source_event_id);
  if (f.erp === 'posted') where.push('e.posted_to_erp_at IS NOT NULL');
  if (f.erp === 'unposted') where.push('e.posted_to_erp_at IS NULL');
  params.push(f.limit, (f.page - 1) * f.limit);
  const r = await q.query<{
    id: string;
    legal_entity_id: string;
    store_id: string | null;
    journal: string;
    entry_date: string;
    account_code: string;
    account_name: string | null;
    debit_minor: string;
    credit_minor: string;
    currency: string;
    source_event_id: string;
    source_topic: string;
    reference_type: string;
    reference_id: string;
    posted_to_erp_at: Date | null;
    erp_reference: string | null;
    created_at: Date;
    total: string;
  }>(
    `SELECT e.id, e.legal_entity_id, e.store_id, e.journal, e.entry_date::text AS entry_date, e.account_code, a.name AS account_name,
            e.debit_minor::text, e.credit_minor::text, e.currency, e.source_event_id, e.source_topic, e.reference_type,
            e.reference_id, e.posted_to_erp_at, e.erp_reference, e.created_at, count(*) OVER()::text AS total
       FROM ledger_entry e
       LEFT JOIN ledger_account a ON a.legal_entity_id = e.legal_entity_id AND a.code = e.account_code
      WHERE ${where.join(' AND ')}
      ORDER BY e.entry_date, e.created_at, e.source_event_id, e.account_code
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return {
    page: f.page,
    limit: f.limit,
    total: n(r.rows[0]?.total),
    items: r.rows.map((row) => ({
      id: row.id,
      legal_entity_id: row.legal_entity_id,
      store_id: row.store_id,
      journal: row.journal,
      entry_date: date(row.entry_date),
      account_code: row.account_code,
      account_name: row.account_name ?? row.account_code,
      debit_minor: n(row.debit_minor),
      credit_minor: n(row.credit_minor),
      currency: row.currency,
      source_event_id: row.source_event_id,
      source_topic: row.source_topic,
      reference_type: row.reference_type,
      reference_id: row.reference_id,
      posted_to_erp_at: ts(row.posted_to_erp_at),
      erp_reference: row.erp_reference,
      created_at: row.created_at.toISOString(),
    })),
  };
}

export async function listParkedEvents(q: Queryable, legalEntityId: string, p: PageQuery) {
  const r = await q.query<{
    outbox_id: string;
    store_id: string;
    topic: string;
    version: number;
    order_id: string;
    occurred_at: Date;
    parked_at: Date;
    total: string;
  }>(
    `SELECT outbox_id, store_id, topic, version, order_id, occurred_at, parked_at, count(*) OVER()::text AS total
       FROM accounting_parked_event
      WHERE store_id IN (SELECT id FROM store WHERE legal_entity_id = $1)
      ORDER BY parked_at, outbox_id
      LIMIT $2 OFFSET $3`,
    [legalEntityId, p.limit, (p.page - 1) * p.limit],
  );
  return {
    page: p.page,
    limit: p.limit,
    total: n(r.rows[0]?.total),
    items: r.rows.map((row) => ({
      outbox_id: row.outbox_id,
      store_id: row.store_id,
      topic: row.topic,
      version: row.version,
      order_id: row.order_id,
      occurred_at: row.occurred_at.toISOString(),
      parked_at: row.parked_at.toISOString(),
    })),
  };
}

export interface PayoutsFilter extends PeriodQuery, PageQuery {
  status?: string;
  provider?: string;
}

interface PayoutRow {
  id: string;
  legal_entity_id: string;
  provider: string;
  provider_payout_id: string;
  currency: string;
  amount_minor: string;
  arrival_date: string;
  status: string;
  line_count: number;
  matched_count: number;
  discrepancy_count: string;
  posted_at: Date | null;
  imported_at: Date;
  reconciled_at: Date | null;
  total?: string;
}

const PAYOUT_SELECT = `SELECT p.id, p.legal_entity_id, p.provider, p.provider_payout_id, p.currency, p.amount_minor::text,
            p.arrival_date::text AS arrival_date, p.status, p.line_count, p.matched_count, p.posted_at, p.imported_at, p.reconciled_at,
            (SELECT count(*)::text FROM psp_payout_line l WHERE l.payout_id = p.id AND l.match_status <> 'matched') AS discrepancy_count`;

const payoutOf = (row: PayoutRow) => ({
  id: row.id,
  legal_entity_id: row.legal_entity_id,
  provider: row.provider,
  provider_payout_id: row.provider_payout_id,
  currency: row.currency,
  amount_minor: n(row.amount_minor),
  arrival_date: date(row.arrival_date)!,
  status: row.status,
  line_count: row.line_count,
  matched_count: row.matched_count,
  discrepancy_count: n(row.discrepancy_count),
  posted_at: ts(row.posted_at),
  imported_at: row.imported_at.toISOString(),
  reconciled_at: ts(row.reconciled_at),
});

export async function listPayouts(q: Queryable, legalEntityId: string, f: PayoutsFilter) {
  const where = ['p.legal_entity_id = $1'];
  const params: unknown[] = [legalEntityId];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (f.status) add('p.status = ?', f.status);
  if (f.provider) add('p.provider = ?', f.provider);
  if (f.from) add('p.arrival_date >= ?::date', f.from);
  if (f.to) add('p.arrival_date <= ?::date', f.to);
  params.push(f.limit, (f.page - 1) * f.limit);
  const r = await q.query<PayoutRow>(
    `${PAYOUT_SELECT}, count(*) OVER()::text AS total
       FROM psp_payout p WHERE ${where.join(' AND ')}
      ORDER BY p.arrival_date, p.provider_payout_id
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { page: f.page, limit: f.limit, total: n(r.rows[0]?.total), items: r.rows.map(payoutOf) };
}

export async function getPayout(
  q: Queryable,
  legalEntityId: string,
  payoutId: string,
  p: PageQuery,
) {
  const r = await q.query<PayoutRow>(
    `${PAYOUT_SELECT} FROM psp_payout p WHERE p.legal_entity_id = $1 AND p.id = $2`,
    [legalEntityId, payoutId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const lines = await q.query<{
    id: string;
    provider_txn_id: string;
    kind: string;
    provider_reference: string | null;
    amount_minor: string;
    fee_minor: string;
    net_minor: string;
    currency: string;
    available_on: string | null;
    matched_reference_type: string | null;
    matched_reference_id: string | null;
    match_status: string;
    difference_minor: string;
    total: string;
  }>(
    `SELECT id, provider_txn_id, kind, provider_reference, amount_minor::text, fee_minor::text, net_minor::text, currency,
            available_on::text AS available_on, matched_reference_type, matched_reference_id, match_status, difference_minor::text, count(*) OVER()::text AS total
       FROM psp_payout_line l WHERE l.payout_id = $1 ORDER BY l.available_on, l.provider_txn_id
      LIMIT $2 OFFSET $3`,
    [payoutId, p.limit, (p.page - 1) * p.limit],
  );
  return {
    ...payoutOf(row),
    lines: {
      page: p.page,
      limit: p.limit,
      total: n(lines.rows[0]?.total),
      items: lines.rows.map((l) => ({
        id: l.id,
        provider_txn_id: l.provider_txn_id,
        kind: l.kind,
        provider_reference: l.provider_reference,
        amount_minor: n(l.amount_minor),
        fee_minor: n(l.fee_minor),
        net_minor: n(l.net_minor),
        currency: l.currency,
        available_on: date(l.available_on),
        matched_reference_type: l.matched_reference_type,
        matched_reference_id: l.matched_reference_id,
        match_status: l.match_status,
        difference_minor: n(l.difference_minor),
      })),
    },
  };
}

export async function erpSyncStatus(q: Queryable, legalEntityId: string) {
  const r = await q.query<{
    odoo_company_id: number | null;
    accounts: string;
    mapped: string;
    unmapped_codes: string[] | null;
    entries: string;
    posted_entries: string;
    oldest_unposted_entry_date: string | null;
    last_posted_at: Date | null;
  }>(
    `SELECT le.odoo_company_id,
            (SELECT count(*)::text FROM ledger_account a WHERE a.legal_entity_id = le.id) AS accounts,
            (SELECT count(*)::text FROM ledger_account a WHERE a.legal_entity_id = le.id AND a.erp_account_id IS NOT NULL) AS mapped,
            (SELECT array_agg(a.code ORDER BY a.code) FROM ledger_account a WHERE a.legal_entity_id = le.id AND a.erp_account_id IS NULL) AS unmapped_codes,
            (SELECT count(*)::text FROM ledger_entry e WHERE e.legal_entity_id = le.id) AS entries,
            (SELECT count(*)::text FROM ledger_entry e WHERE e.legal_entity_id = le.id AND e.posted_to_erp_at IS NOT NULL) AS posted_entries,
            (SELECT min(e.entry_date)::text FROM ledger_entry e WHERE e.legal_entity_id = le.id AND e.posted_to_erp_at IS NULL) AS oldest_unposted_entry_date,
            (SELECT max(e.posted_to_erp_at) FROM ledger_entry e WHERE e.legal_entity_id = le.id) AS last_posted_at
       FROM legal_entity le WHERE le.id = $1`,
    [legalEntityId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const entries = n(row.entries);
  const posted = n(row.posted_entries);
  return {
    legal_entity_id: legalEntityId,
    odoo_company_id: row.odoo_company_id,
    chart: {
      accounts: n(row.accounts),
      mapped: n(row.mapped),
      unmapped_codes: row.unmapped_codes ?? [],
    },
    entries,
    posted_entries: posted,
    unposted_entries: entries - posted,
    oldest_unposted_entry_date: date(row.oldest_unposted_entry_date),
    last_posted_at: ts(row.last_posted_at),
  };
}
