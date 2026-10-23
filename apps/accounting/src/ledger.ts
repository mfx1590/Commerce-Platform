// ledger_entry and ledger_account on a scoped transaction: the chart seed, the row writes, the trial balance.
import type { Queryable } from '@platform/db';
import { DEFAULT_CHART } from './chart.js';
import type { JournalEntry } from './posting/types.js';

/** Seeds the default chart for a legal entity; a second call changes nothing (the accountant's edits survive). */
export async function ensureChart(
  tx: Queryable,
  organizationId: string,
  legalEntityId: string,
): Promise<number> {
  const r = await tx.query(
    `INSERT INTO ledger_account (organization_id, legal_entity_id, code, name, type)
     SELECT $1, $2, c, n, t FROM unnest($3::text[], $4::text[], $5::text[]) AS x(c, n, t)
     ON CONFLICT (legal_entity_id, code) DO NOTHING`,
    [
      organizationId,
      legalEntityId,
      DEFAULT_CHART.map((a) => a.code),
      DEFAULT_CHART.map((a) => a.name),
      DEFAULT_CHART.map((a) => a.type),
    ],
  );
  return r.rowCount ?? 0;
}

/** Writes one entry's lines; returns the number of rows. UNIQUE (source_event_id, account_code) is the DB guard. */
export async function insertJournalEntry(
  tx: Queryable,
  organizationId: string,
  entry: JournalEntry,
): Promise<number> {
  if (entry.lines.length === 0) return 0;
  const r = await tx.query(
    `INSERT INTO ledger_entry (organization_id, legal_entity_id, store_id, journal, entry_date, account_code,
       debit_minor, credit_minor, currency, source_event_id, source_topic, reference_type, reference_id)
     SELECT $1, $2, $3, $4, $5::date, a, d, c, cur, $6, $7, $8, $9
       FROM unnest($10::text[], $11::bigint[], $12::bigint[], $13::text[]) AS t(a, d, c, cur)`,
    [
      organizationId,
      entry.legal_entity_id,
      entry.store_id,
      entry.journal,
      entry.entry_date,
      entry.source_event_id,
      entry.source_topic,
      entry.reference_type,
      entry.reference_id,
      entry.lines.map((l) => l.account_code),
      entry.lines.map((l) => l.debit_minor),
      entry.lines.map((l) => l.credit_minor),
      entry.lines.map((l) => l.currency),
    ],
  );
  return r.rowCount ?? 0;
}

export interface TrialBalanceRow {
  currency: string;
  account_code: string;
  debit_minor: number;
  credit_minor: number;
  /** debit − credit */
  balance_minor: number;
}

/** Per (currency, account) totals of a legal entity, optionally bounded by entry_date (inclusive). */
export async function trialBalance(
  tx: Queryable,
  legalEntityId: string,
  period: { from?: string; to?: string } = {},
): Promise<TrialBalanceRow[]> {
  const r = await tx.query<{
    currency: string;
    account_code: string;
    debit: string;
    credit: string;
  }>(
    `SELECT currency, account_code, sum(debit_minor)::text AS debit, sum(credit_minor)::text AS credit
       FROM ledger_entry
      WHERE legal_entity_id = $1
        AND ($2::date IS NULL OR entry_date >= $2::date)
        AND ($3::date IS NULL OR entry_date <= $3::date)
      GROUP BY currency, account_code
      ORDER BY currency, account_code`,
    [legalEntityId, period.from ?? null, period.to ?? null],
  );
  return r.rows.map((row) => ({
    currency: row.currency,
    account_code: row.account_code,
    debit_minor: Number(row.debit),
    credit_minor: Number(row.credit),
    balance_minor: Number(row.debit) - Number(row.credit),
  }));
}

/** Σ debit − Σ credit per currency of a legal entity: zero on balanced books. */
export async function balanceByCurrency(
  tx: Queryable,
  legalEntityId: string,
): Promise<Record<string, number>> {
  const r = await tx.query<{ currency: string; diff: string }>(
    `SELECT currency, (sum(debit_minor) - sum(credit_minor))::text AS diff
       FROM ledger_entry WHERE legal_entity_id = $1 GROUP BY currency ORDER BY currency`,
    [legalEntityId],
  );
  return Object.fromEntries(r.rows.map((row) => [row.currency, Number(row.diff)]));
}
