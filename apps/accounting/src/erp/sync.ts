// ERP sync loop (#550): posts the ledger's journal entries to Odoo as `account.move`s per legal entity (company =
// legal_entity.odoo_company_id), idempotently, and records `posted_to_erp_at` / `erp_reference` on the rows.
//
//   one move per (source_event_id, journal)   ref = `<source_event_id>/<journal>` — the idempotency key on the Odoo side
//   search before create                      a crash between create and mark is recovered: the next run finds the move
//                                             by ref and marks the rows without creating a second one
//   a refused move is reported                (class + source event id + journal) and the rest of the batch continues;
//                                             its rows stay unposted for the next run
//   currency                                  a move is posted only in the company's currency (no FX this phase);
//                                             another currency is reported as skipped
//
// Mapping steps, both ours (docs/domain.md: legal_entity.odoo_company_id is window 15's column):
//   mapLegalEntityToCompany   legal_entity.odoo_company_id ← the Odoo company
//   mapChart                  ledger_account.erp_account_id ← the Odoo account with the same code (or the code map's)
import type { Queryable, ScopedClient } from '@platform/db';
import { consoleLogger, type Logger } from '../log.js';
import type { Journal } from '../posting/types.js';
import { ErpError, toCurrencyUnits, type ErpAdapter, type ErpMoveLine } from './types.js';

export const DEFAULT_JOURNAL_CODES: Record<Journal, string> = {
  sales: 'SAL',
  psp_fees: 'PSP',
  refunds: 'REF',
  shipping: 'SHP',
  bank: 'BNK',
  cogs: 'COGS',
  tax: 'TAX',
};

export interface ErpSyncDeps {
  /** Organization-scoped client over the app-role pool. */
  client: ScopedClient;
  erp: ErpAdapter;
  log?: Logger;
  /** (source_event_id, journal) groups per pass. Default 200. */
  batchSize?: number;
  /** Our journal → the Odoo journal code. */
  journalCodes?: Partial<Record<Journal, string>>;
  /** Our account code → the Odoo account code, when the accountant's chart uses other codes. Default: identity. */
  accountCodeMap?: Record<string, string>;
}

export interface ChartMappingResult {
  mapped: number;
  already: number;
  /** Our codes with no Odoo account in the company (their entries are skipped until the accountant adds them). */
  missing: string[];
}

export interface ErpSyncResult {
  legal_entity_id: string;
  company_id: number;
  chart: ChartMappingResult;
  moves_created: number;
  /** Moves that already existed in Odoo (a crash between create and mark on an earlier run): rows marked, nothing created. */
  moves_found: number;
  /** Of those, drafts (a crash between create and action_post) that this run posted before marking. */
  moves_posted_drafts: number;
  entries_marked: number;
  refused: { source_event_id: string; journal: string; error_class: string }[];
  skipped: {
    source_event_id: string;
    journal: string;
    reason: 'account_unmapped' | 'journal_missing' | 'currency_unsupported';
  }[];
}

/**
 * Legal entities the ERP sync touches. The admin e2e journeys leave `e2e-…` legal entities in the shared dev database
 * (one per run); they are not books and never reach Odoo (manager decision 2026-10-24).
 */
export function isSyncableLegalEntity(code: string): boolean {
  return !code.startsWith('e2e-');
}

export async function assertSyncable(q: Queryable, legalEntityId: string): Promise<string> {
  const r = await q.query<{ code: string }>('SELECT code FROM legal_entity WHERE id = $1', [
    legalEntityId,
  ]);
  const code = r.rows[0]?.code;
  if (code === undefined)
    throw new ErpError('LegalEntityUnknown', `legal entity ${legalEntityId} not visible`);
  if (!isSyncableLegalEntity(code))
    throw new ErpError('LegalEntityExcluded', `legal entity ${code} is an e2e fixture`);
  return code;
}

/** Fills legal_entity.odoo_company_id (the mapping step; never by hand in SQL). An e2e legal entity is refused. */
export async function mapLegalEntityToCompany(
  client: ScopedClient,
  legalEntityId: string,
  companyId: number,
): Promise<void> {
  await assertSyncable(client, legalEntityId);
  const r = await client.query('UPDATE legal_entity SET odoo_company_id = $2 WHERE id = $1', [
    legalEntityId,
    companyId,
  ]);
  if ((r.rowCount ?? 0) === 0)
    throw new ErpError('LegalEntityUnknown', `legal entity ${legalEntityId} not visible`);
}

export async function companyOf(q: Queryable, legalEntityId: string): Promise<number | null> {
  const r = await q.query<{ odoo_company_id: number | null }>(
    'SELECT odoo_company_id FROM legal_entity WHERE id = $1',
    [legalEntityId],
  );
  if (r.rows.length === 0)
    throw new ErpError('LegalEntityUnknown', `legal entity ${legalEntityId} not visible`);
  return r.rows[0]!.odoo_company_id;
}

/** ledger_account.erp_account_id ← the Odoo account of the same code (or the code map's); idempotent. */
export async function mapChart(
  deps: ErpSyncDeps,
  legalEntityId: string,
): Promise<ChartMappingResult> {
  const companyId = await companyOf(deps.client, legalEntityId);
  if (companyId === null)
    throw new ErpError(
      'LegalEntityUnmapped',
      `legal entity ${legalEntityId} has no odoo_company_id`,
    );
  const odooAccounts = await deps.erp.listAccounts(companyId);
  const byCode = new Map(odooAccounts.map((a) => [a.code, a]));
  const ours = await deps.client.query<{ id: string; code: string; erp_account_id: number | null }>(
    'SELECT id, code, erp_account_id FROM ledger_account WHERE legal_entity_id = $1 ORDER BY code',
    [legalEntityId],
  );
  const result: ChartMappingResult = { mapped: 0, already: 0, missing: [] };
  for (const a of ours.rows) {
    if (a.erp_account_id !== null) {
      result.already += 1;
      continue;
    }
    const odoo = byCode.get(deps.accountCodeMap?.[a.code] ?? a.code);
    if (!odoo) {
      result.missing.push(a.code);
      continue;
    }
    await deps.client.query('UPDATE ledger_account SET erp_account_id = $2 WHERE id = $1', [
      a.id,
      odoo.id,
    ]);
    result.mapped += 1;
  }
  return result;
}

interface EntryRow {
  id: string;
  source_event_id: string;
  journal: Journal;
  /** `YYYY-MM-DD`, selected ::text: the Odoo move date, never a local-midnight Date (#627). */
  entry_date: string;
  account_code: string;
  debit_minor: string;
  credit_minor: string;
  currency: string;
  erp_account_id: number | null;
  account_name: string;
}

async function unpostedGroups(
  q: Queryable,
  legalEntityId: string,
  batch: number,
  exclude: string[],
): Promise<EntryRow[]> {
  const r = await q.query<EntryRow>(
    `WITH groups AS (
       SELECT source_event_id, journal
         FROM ledger_entry
        WHERE legal_entity_id = $1 AND posted_to_erp_at IS NULL
          AND NOT (source_event_id::text || '/' || journal = ANY($3::text[]))
        GROUP BY source_event_id, journal
        ORDER BY min(created_at), source_event_id, journal
        LIMIT $2)
     SELECT e.id, e.source_event_id, e.journal, e.entry_date::text AS entry_date, e.account_code, e.debit_minor::text, e.credit_minor::text,
            e.currency, a.erp_account_id, a.name AS account_name
       FROM ledger_entry e
       JOIN groups g ON g.source_event_id = e.source_event_id AND g.journal = e.journal
       LEFT JOIN ledger_account a ON a.legal_entity_id = e.legal_entity_id AND a.code = e.account_code
      WHERE e.legal_entity_id = $1 AND e.posted_to_erp_at IS NULL
      ORDER BY e.created_at, e.source_event_id, e.journal, e.account_code`,
    [legalEntityId, batch, exclude],
  );
  return r.rows;
}

/**
 * Posts every unposted entry of the legal entity; returns what happened. Safe to re-run, and ONE run per legal entity
 * at a time (#639): a dedicated transaction holds `pg_try_advisory_xact_lock(hashtext('erp_sync'), hashtext(<legal
 * entity>))` for the whole run (the two-key form: its own keyspace, never an order's lock). A second run that overlaps
 * fails fast with `ErpSyncInProgress` and touches nothing; before, two overlapping runs both found no move by ref and
 * both created one, two posted moves with one ref in Odoo. The lock is released when the run ends (commit) or the
 * process dies (the session ends). It holds one pool connection for the run's duration (the CLI pool has two).
 */
export async function syncLegalEntity(
  deps: ErpSyncDeps,
  legalEntityId: string,
): Promise<ErpSyncResult> {
  // The lock transaction does NOTHING but hold the lock: runSync uses deps.client, so every ledger write (the marks)
  // commits in its own short statement on another connection and a long Odoo call never holds a row lock. A
  // hashtext collision between two legal entities only serialises their two syncs — harmless (#639).
  return deps.client.transaction(async (lockTx) => {
    const got = await lockTx.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext('erp_sync'), hashtext($1)) AS ok`,
      [legalEntityId],
    );
    if (!got.rows[0]?.ok)
      throw new ErpError(
        'ErpSyncInProgress',
        `another erp:sync is running for legal entity ${legalEntityId}`,
      );
    return runSync(deps, legalEntityId);
  });
}

async function runSync(deps: ErpSyncDeps, legalEntityId: string): Promise<ErpSyncResult> {
  const log = deps.log ?? consoleLogger;
  const batch = deps.batchSize ?? 200;
  await assertSyncable(deps.client, legalEntityId);
  const companyId = await companyOf(deps.client, legalEntityId);
  if (companyId === null)
    throw new ErpError(
      'LegalEntityUnmapped',
      `legal entity ${legalEntityId} has no odoo_company_id`,
    );
  const chart = await mapChart(deps, legalEntityId);
  const company = (await deps.erp.listCompanies()).find((c) => c.id === companyId);
  if (!company) throw new ErpError('ErpCompanyMissing', `company ${companyId} is not in the ERP`);
  const journals = new Map((await deps.erp.listJournals(companyId)).map((j) => [j.code, j]));
  const journalCodes = { ...DEFAULT_JOURNAL_CODES, ...deps.journalCodes };

  const result: ErpSyncResult = {
    legal_entity_id: legalEntityId,
    company_id: companyId,
    chart,
    moves_created: 0,
    moves_found: 0,
    moves_posted_drafts: 0,
    entries_marked: 0,
    refused: [],
    skipped: [],
  };
  const done: string[] = [];

  for (;;) {
    const rows = await unpostedGroups(deps.client, legalEntityId, batch, done);
    if (rows.length === 0) break;
    const groups = new Map<string, EntryRow[]>();
    for (const row of rows) {
      const key = `${row.source_event_id}/${row.journal}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const [ref, entries] of groups) {
      done.push(ref);
      const first = entries[0]!;
      const base = { source_event_id: first.source_event_id, journal: first.journal };
      const journal = journals.get(journalCodes[first.journal]);
      if (!journal) {
        result.skipped.push({ ...base, reason: 'journal_missing' });
        log.warn({
          event: 'erp_skipped',
          ...base,
          reason: 'journal_missing',
          journal_code: journalCodes[first.journal],
        });
        continue;
      }
      if (entries.some((e) => e.currency !== company.currency)) {
        result.skipped.push({ ...base, reason: 'currency_unsupported' });
        log.warn({
          event: 'erp_skipped',
          ...base,
          reason: 'currency_unsupported',
          currency: first.currency,
          company_currency: company.currency,
        });
        continue;
      }
      if (entries.some((e) => e.erp_account_id === null)) {
        result.skipped.push({ ...base, reason: 'account_unmapped' });
        log.warn({
          event: 'erp_skipped',
          ...base,
          reason: 'account_unmapped',
          account_codes: entries
            .filter((e) => e.erp_account_id === null)
            .map((e) => e.account_code),
        });
        continue;
      }
      const ids = entries.map((e) => e.id);
      const mark = async (moveId: number): Promise<void> => {
        const r = await deps.client.query(
          'UPDATE ledger_entry SET posted_to_erp_at = now(), erp_reference = $2 WHERE id = ANY($1::uuid[]) AND posted_to_erp_at IS NULL',
          [ids, String(moveId)],
        );
        result.entries_marked += r.rowCount ?? 0;
      };
      try {
        const existing = await deps.erp.findMoveByRef(companyId, ref);
        if (existing) {
          // cancelled in Odoo by an accountant (and nothing else carries the ref): neither re-posted nor marked —
          // reported like a refusal, the rest continue, and every run reports it until someone decides (#591)
          if (existing.state === 'cancel')
            throw new ErpError(
              'OdooMoveCancelled',
              `move ${existing.id} with ref ${ref} was cancelled in Odoo`,
            );
          // a draft = a crash between create and action_post on an earlier run: post it, THEN mark (#575)
          if (existing.state !== 'posted') {
            await deps.erp.postMove(existing.id);
            result.moves_posted_drafts += 1;
          }
          await mark(existing.id);
          result.moves_found += 1;
          log.info({
            event: 'erp_move_found',
            ...base,
            move_id: existing.id,
            lines: ids.length,
            was_draft: existing.state !== 'posted',
          });
          continue;
        }
        const lines: ErpMoveLine[] = entries.map((e) => ({
          account_id: e.erp_account_id!,
          name: `${e.account_code} ${e.account_name}`,
          debit: toCurrencyUnits(Number(e.debit_minor), e.currency),
          credit: toCurrencyUnits(Number(e.credit_minor), e.currency),
        }));
        const move = await deps.erp.createMove({
          company_id: companyId,
          journal_id: journal.id,
          date: first.entry_date,
          ref,
          lines,
        });
        await mark(move.id);
        result.moves_created += 1;
        log.info({
          event: 'erp_move_created',
          ...base,
          move_id: move.id,
          lines: lines.length,
          currency: company.currency,
        });
      } catch (err) {
        const error_class = err instanceof Error ? err.name : 'Error';
        result.refused.push({ ...base, error_class });
        log.warn({ event: 'erp_refused', ...base, error_class });
      }
    }
  }
  log.info({
    event: 'erp_sync_done',
    legal_entity_id: legalEntityId,
    company_id: companyId,
    moves_created: result.moves_created,
    moves_found: result.moves_found,
    moves_posted_drafts: result.moves_posted_drafts,
    entries_marked: result.entries_marked,
    refused: result.refused.length,
    skipped: result.skipped.length,
    chart_mapped: chart.mapped,
    chart_missing: chart.missing.length,
  });
  return result;
}
