// ERP sync (#550) against the in-memory Odoo through the real JSON-RPC client: the client's transport and fault
// handling, then the sync on a seeded database with the clean-month ledger — chart mapping, one move per (event,
// journal) created once, a re-run creating nothing, a refused move reported while the rest continue, a crash between
// create and mark recovered by ref, a missing Odoo account skipping only its entries. A live block runs when ODOO_URL
// answers (the owner's instance is still open: skipped with a printed reason until then).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SEED_IDS } from '@platform/db';
import type { EventEnvelopeV1Base } from '@platform/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleLedgerEvent } from '../src/consumer.js';
import { createMockOdoo, MOCK_ODOO_CREDENTIALS } from '../src/erp/mock.js';
import { OdooJsonRpcClient, odooCredentialsFromEnv } from '../src/erp/odoo-jsonrpc.js';
import {
  isSyncableLegalEntity,
  mapChart,
  mapLegalEntityToCompany,
  syncLegalEntity,
} from '../src/erp/sync.js';
import { ErpError, toCurrencyUnits } from '../src/erp/types.js';
import type { Logger } from '../src/log.js';
import { LE_A, LE_B } from '../src/posting/fixtures.js';
import { FIXTURES_DIR } from '../src/reconcile/fixtures/write.js';
import { createAccountingTestDatabase, type AccountingTestDatabase } from './helpers/db.js';

const LOG: string[] = [];
const log: Logger = {
  info: (l) => LOG.push(JSON.stringify(l)),
  warn: (l) => LOG.push(JSON.stringify(l)),
  error: (l) => LOG.push(JSON.stringify(l)),
};
const noWait = async () => {};

describe('Odoo JSON-RPC client against the mock server', () => {
  it('authenticates once, lists companies / accounts / journals, creates and posts a balanced move', async () => {
    const mock = createMockOdoo();
    const odoo = new OdooJsonRpcClient(MOCK_ODOO_CREDENTIALS, { fetch: mock.fetch, sleep: noWait });
    const companies = await odoo.listCompanies();
    expect(companies.map((c) => [c.id, c.currency])).toEqual([
      [1, 'EUR'],
      [2, 'GBP'],
    ]);
    const accounts = await odoo.listAccounts(1);
    expect(accounts).toHaveLength(12);
    const journals = await odoo.listJournals(1);
    const sal = journals.find((j) => j.code === 'SAL')!;
    const ar = accounts.find((a) => a.code === '1200')!;
    const cl = accounts.find((a) => a.code === '2300')!;
    const move = await odoo.createMove({
      company_id: 1,
      journal_id: sal.id,
      date: '2026-10-05',
      ref: 'evt-1/sales',
      lines: [
        { account_id: ar.id, name: '1200 AR', debit: 136.65, credit: 0 },
        { account_id: cl.id, name: '2300 CL', debit: 0, credit: 136.65 },
      ],
    });
    expect(move.state).toBe('posted');
    expect(mock.state.moves[0]).toMatchObject({ ref: 'evt-1/sales', state: 'posted' });
    expect(await odoo.findMoveByRef(1, 'evt-1/sales')).toMatchObject({
      id: move.id,
      state: 'posted',
    });
    expect(await odoo.findMoveByRef(2, 'evt-1/sales')).toBeNull();
    expect(mock.state.calls.filter((c) => c === 'common.authenticate')).toHaveLength(1);
  });

  it('wrong credentials fail with OdooAuthFailed; transport failures are retried with a bound', async () => {
    const bad = new OdooJsonRpcClient(
      { ...MOCK_ODOO_CREDENTIALS, apiKey: 'another-word' },
      { fetch: createMockOdoo().fetch, sleep: noWait },
    );
    await expect(bad.listCompanies()).rejects.toMatchObject({ name: 'OdooAuthFailed' });
    const flaky = new OdooJsonRpcClient(MOCK_ODOO_CREDENTIALS, {
      fetch: createMockOdoo({ failFirst: 2 }).fetch,
      retries: 2,
      sleep: noWait,
    });
    expect((await flaky.listCompanies()).length).toBe(2);
    const down = new OdooJsonRpcClient(MOCK_ODOO_CREDENTIALS, {
      fetch: createMockOdoo({ failFirst: 5 }).fetch,
      retries: 2,
      sleep: noWait,
    });
    await expect(down.listCompanies()).rejects.toMatchObject({ name: 'OdooTransport' });
  });

  it('the mock enforces Odoo rules: unbalanced move, unknown account, company mismatch, archived account', async () => {
    const mock = createMockOdoo();
    const odoo = new OdooJsonRpcClient(MOCK_ODOO_CREDENTIALS, { fetch: mock.fetch, sleep: noWait });
    const [a1, a2] = [await odoo.listAccounts(1), await odoo.listAccounts(2)];
    const j1 = (await odoo.listJournals(1)).find((j) => j.code === 'SAL')!;
    const j2 = (await odoo.listJournals(2)).find((j) => j.code === 'SAL')!;
    const line = (account_id: number, debit: number, credit: number) => ({
      account_id,
      name: 'x',
      debit,
      credit,
    });
    await expect(
      odoo.createMove({
        company_id: 1,
        journal_id: j1.id,
        date: '2026-10-05',
        ref: 'u',
        lines: [line(a1[0]!.id, 10, 0), line(a1[1]!.id, 0, 9.99)],
      }),
    ).rejects.toMatchObject({ name: 'OdooUnbalancedMove' });
    await expect(
      odoo.createMove({
        company_id: 1,
        journal_id: j1.id,
        date: '2026-10-05',
        ref: 'a',
        lines: [line(99_999, 1, 0), line(a1[1]!.id, 0, 1)],
      }),
    ).rejects.toMatchObject({ name: 'OdooAccountMissing' });
    await expect(
      odoo.createMove({
        company_id: 1,
        journal_id: j2.id,
        date: '2026-10-05',
        ref: 'c',
        lines: [line(a1[0]!.id, 1, 0), line(a1[1]!.id, 0, 1)],
      }),
    ).rejects.toMatchObject({ name: 'OdooCompanyMismatch' });
    await expect(
      odoo.createMove({
        company_id: 1,
        journal_id: j1.id,
        date: '2026-10-05',
        ref: 'c2',
        lines: [line(a2[0]!.id, 1, 0), line(a1[1]!.id, 0, 1)],
      }),
    ).rejects.toMatchObject({ name: 'OdooCompanyMismatch' });
    mock.archiveAccount(a1[0]!.id);
    await expect(
      odoo.createMove({
        company_id: 1,
        journal_id: j1.id,
        date: '2026-10-05',
        ref: 'arch',
        lines: [line(a1[0]!.id, 1, 0), line(a1[1]!.id, 0, 1)],
      }),
    ).rejects.toMatchObject({ name: 'OdooAccountMissing' });
    expect(mock.state.moves).toEqual([]);
    expect(toCurrencyUnits(13_665, 'EUR')).toBe(136.65);
    expect(toCurrencyUnits(13_665, 'JPY')).toBe(13_665);
    expect(() => odooCredentialsFromEnv({})).toThrow(ErpError);
  });
});

describe('sync on a seeded database with the clean-month ledger', () => {
  let t: AccountingTestDatabase;
  let mock: ReturnType<typeof createMockOdoo>;
  let odoo: OdooJsonRpcClient;
  const count = async (sql: string, params: unknown[] = []) =>
    Number(
      (await t.hq.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params)).rows[0]!
        .n,
    );
  const groupsOf = (le: string) =>
    count(
      '(SELECT 1 FROM ledger_entry WHERE legal_entity_id = $1 GROUP BY source_event_id, journal) g',
      [le],
    );
  const deps = () => ({ client: t.hq, erp: odoo, log, batchSize: 50 });

  beforeAll(async () => {
    t = await createAccountingTestDatabase();
    const events = JSON.parse(
      await readFile(path.join(FIXTURES_DIR, 'clean-month', 'events.json'), 'utf8'),
    ) as EventEnvelopeV1Base[];
    for (const e of events)
      await handleLedgerEvent(t.hq, {
        envelope: e,
        outboxId: e.event_id,
        schemaId: null,
        headers: {},
      });
    mock = createMockOdoo();
    odoo = new OdooJsonRpcClient(MOCK_ODOO_CREDENTIALS, { fetch: mock.fetch, sleep: noWait });
  }, 180_000);

  afterAll(async () => {
    await t?.drop();
  });

  it('an unmapped legal entity is refused; the mapping step fills legal_entity.odoo_company_id', async () => {
    await expect(syncLegalEntity(deps(), LE_A)).rejects.toMatchObject({
      name: 'LegalEntityUnmapped',
    });
    await mapLegalEntityToCompany(t.hq, LE_A, 1);
    await mapLegalEntityToCompany(t.hq, LE_B, 2);
    const row = await t.hq.query<{ odoo_company_id: number }>(
      'SELECT odoo_company_id FROM legal_entity WHERE id = $1',
      [LE_A],
    );
    expect(row.rows[0]!.odoo_company_id).toBe(1);
    await expect(
      mapLegalEntityToCompany(t.hq, '00000000-0000-4000-8000-0000000000ee', 1),
    ).rejects.toMatchObject({ name: 'LegalEntityUnknown' });
  });

  it('maps the chart, posts one balanced move per (event, journal) once, marks every row; a re-run creates nothing', async () => {
    const groups = await groupsOf(LE_A);
    const first = await syncLegalEntity(deps(), LE_A);
    expect(first.chart).toEqual({ mapped: 12, already: 0, missing: [] });
    expect(first).toMatchObject({
      company_id: 1,
      moves_created: groups,
      moves_found: 0,
      refused: [],
      skipped: [],
    });
    expect(first.entries_marked).toBe(
      await count('ledger_entry WHERE legal_entity_id = $1', [LE_A]),
    );
    expect(
      await count('ledger_entry WHERE legal_entity_id = $1 AND posted_to_erp_at IS NULL', [LE_A]),
    ).toBe(0);
    expect(
      await count('ledger_account WHERE legal_entity_id = $1 AND erp_account_id IS NULL', [LE_A]),
    ).toBe(0);
    expect(mock.state.moves.filter((m) => m.company_id === 1)).toHaveLength(groups);
    for (const m of mock.state.moves) {
      expect(m.state).toBe('posted');
      const d = m.lines.reduce((a, l) => a + l.debit, 0);
      const c = m.lines.reduce((a, l) => a + l.credit, 0);
      expect(Math.round(d * 100)).toBe(Math.round(c * 100));
      expect(m.ref).toMatch(/^[0-9a-f-]{36}\/(sales|psp_fees|refunds|shipping|bank)$/);
    }
    // erp_reference is the Odoo move id, per row
    const refs = await t.hq.query<{ erp_reference: string; n: string }>(
      'SELECT erp_reference, count(*)::text AS n FROM ledger_entry WHERE legal_entity_id = $1 GROUP BY erp_reference',
      [LE_A],
    );
    expect(refs.rows.length).toBe(groups);
    expect(
      refs.rows.every((r) => mock.state.moves.some((m) => String(m.id) === r.erp_reference)),
    ).toBe(true);

    const again = await syncLegalEntity(deps(), LE_A);
    expect(again).toMatchObject({
      moves_created: 0,
      moves_found: 0,
      entries_marked: 0,
      refused: [],
      skipped: [],
    });
    expect(again.chart).toEqual({ mapped: 0, already: 12, missing: [] });
    expect(mock.state.moves.filter((m) => m.company_id === 1)).toHaveLength(groups);
  });

  it('a refused move is reported with its class and entry; the rest continue; the next run posts it', async () => {
    const groups = await groupsOf(LE_B);
    mock.refuseNextCreate(
      'odoo.exceptions.UserError',
      'cannot create unbalanced journal entry (fixture refusal)',
    );
    const r = await syncLegalEntity(deps(), LE_B);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0]).toMatchObject({
      error_class: 'OdooUnbalancedMove',
      journal: expect.any(String),
    });
    expect(r.moves_created).toBe(groups - 1);
    expect(
      await count(
        'ledger_entry WHERE legal_entity_id = $1 AND posted_to_erp_at IS NULL AND source_event_id = $2',
        [LE_B, r.refused[0]!.source_event_id],
      ),
    ).toBeGreaterThan(0);
    expect(
      LOG.some(
        (l) => l.includes('"event":"erp_refused"') && l.includes(r.refused[0]!.source_event_id),
      ),
    ).toBe(true);
    const next = await syncLegalEntity(deps(), LE_B);
    expect(next).toMatchObject({ moves_created: 1, refused: [] });
    expect(
      await count('ledger_entry WHERE legal_entity_id = $1 AND posted_to_erp_at IS NULL', [LE_B]),
    ).toBe(0);
    expect(mock.state.moves.filter((m) => m.company_id === 2)).toHaveLength(groups);
  });

  it('a crash between create and mark is recovered by ref: the move is found, the rows marked, nothing created twice', async () => {
    // a fresh entry pair the sync has not seen: insert as the ledger would, then pre-create its move in Odoo
    const eventId = '00000000-0000-4000-8000-00000000cafe';
    await t.hq.query(
      `INSERT INTO ledger_entry (organization_id, legal_entity_id, store_id, journal, entry_date, account_code, debit_minor, credit_minor, currency, source_event_id, source_topic, reference_type, reference_id)
       SELECT organization_id, $1, NULL, 'bank', '2026-10-30', a, d, c, 'EUR', $2, 'psp.payout', 'payout', $2
         FROM legal_entity, unnest(ARRAY['1000', '1100'], ARRAY[500, 0]::bigint[], ARRAY[0, 500]::bigint[]) AS x(a, d, c)
        WHERE legal_entity.id = $1`,
      [LE_A, eventId],
    );
    const bnk = (await odoo.listJournals(1)).find((j) => j.code === 'BNK')!;
    const accounts = await odoo.listAccounts(1);
    const before = mock.state.moves.length;
    const pre = await odoo.createMove({
      company_id: 1,
      journal_id: bnk.id,
      date: '2026-10-30',
      ref: `${eventId}/bank`,
      lines: [
        {
          account_id: accounts.find((a) => a.code === '1000')!.id,
          name: '1000 Bank',
          debit: 5,
          credit: 0,
        },
        {
          account_id: accounts.find((a) => a.code === '1100')!.id,
          name: '1100 PSP clearing',
          debit: 0,
          credit: 5,
        },
      ],
    });
    const r = await syncLegalEntity(deps(), LE_A);
    expect(r).toMatchObject({ moves_created: 0, moves_found: 1, entries_marked: 2 });
    expect(mock.state.moves.length).toBe(before + 1);
    const marked = await t.hq.query<{ erp_reference: string }>(
      'SELECT DISTINCT erp_reference FROM ledger_entry WHERE source_event_id = $1',
      [eventId],
    );
    expect(marked.rows).toEqual([{ erp_reference: String(pre.id) }]);
  });

  it('e2e legal entities never reach Odoo: the mapping step and the sync refuse them (manager decision 2026-10-24)', async () => {
    expect(isSyncableLegalEntity('le-brand-a')).toBe(true);
    expect(isSyncableLegalEntity('e2e-brand-muzxqspo-bv')).toBe(false);
    const e2eId = '00000000-0000-4000-8000-00000000e2e0';
    await t.db.owner.query(
      `INSERT INTO legal_entity (id, organization_id, code, name, country, currency) VALUES ($1, $2, 'e2e-brand-fixture-bv', 'E2E fixture B.V.', 'NL', 'EUR')`,
      [e2eId, SEED_IDS.organization],
    );
    await expect(mapLegalEntityToCompany(t.hq, e2eId, 1)).rejects.toMatchObject({
      name: 'LegalEntityExcluded',
    });
    await expect(syncLegalEntity(deps(), e2eId)).rejects.toMatchObject({
      name: 'LegalEntityExcluded',
    });
    const row = await t.hq.query<{ odoo_company_id: number | null }>(
      'SELECT odoo_company_id FROM legal_entity WHERE id = $1',
      [e2eId],
    );
    expect(row.rows[0]!.odoo_company_id).toBeNull();
  });

  it('#575 (1): a DRAFT left by a crash between create and action_post is posted before its rows are marked', async () => {
    // a fresh entry pair; its move is created directly (what the client does before action_post) and left draft
    const eventId = '00000000-0000-4000-8000-00000000d1a7';
    await t.hq.query(
      `INSERT INTO ledger_entry (organization_id, legal_entity_id, store_id, journal, entry_date, account_code, debit_minor, credit_minor, currency, source_event_id, source_topic, reference_type, reference_id)
       SELECT organization_id, $1, NULL, 'bank', '2026-10-30', a, d, c, 'EUR', $2, 'psp.payout', 'payout', $2
         FROM legal_entity, unnest(ARRAY['1000', '1100'], ARRAY[700, 0]::bigint[], ARRAY[0, 700]::bigint[]) AS x(a, d, c)
        WHERE legal_entity.id = $1`,
      [LE_A, eventId],
    );
    const bnk = (await odoo.listJournals(1)).find((j) => j.code === 'BNK')!;
    const accounts = await odoo.listAccounts(1);
    const draftId = (await odoo.executeKw('account.move', 'create', [
      {
        move_type: 'entry',
        company_id: 1,
        journal_id: bnk.id,
        date: '2026-10-30',
        ref: `${eventId}/bank`,
        line_ids: [
          [
            0,
            0,
            {
              account_id: accounts.find((a) => a.code === '1000')!.id,
              name: '1000',
              debit: 7,
              credit: 0,
            },
          ],
          [
            0,
            0,
            {
              account_id: accounts.find((a) => a.code === '1100')!.id,
              name: '1100',
              debit: 0,
              credit: 7,
            },
          ],
        ],
      },
    ])) as number;
    expect(mock.state.moves.find((m) => m.id === draftId)!.state).toBe('draft');
    const before = mock.state.moves.length;
    const r = await syncLegalEntity(deps(), LE_A);
    expect(r).toMatchObject({
      moves_created: 0,
      moves_found: 1,
      moves_posted_drafts: 1,
      entries_marked: 2,
    });
    expect(mock.state.moves.length).toBe(before);
    expect(mock.state.moves.find((m) => m.id === draftId)!.state).toBe('posted');
    const marked = await t.hq.query<{ erp_reference: string; posted: Date | null }>(
      'SELECT DISTINCT erp_reference, posted_to_erp_at AS posted FROM ledger_entry WHERE source_event_id = $1',
      [eventId],
    );
    expect(marked.rows).toHaveLength(1);
    expect(marked.rows[0]).toMatchObject({ erp_reference: String(draftId) });
    expect(marked.rows[0]!.posted).not.toBeNull();
    expect(LOG.some((l) => l.includes('"was_draft":true'))).toBe(true);
  });

  it('#575 (2): a create whose answer is lost after Odoo committed it is NOT retried blindly — the move is found by ref and posted, once', async () => {
    const eventId = '00000000-0000-4000-8000-00000000d1a8';
    await t.hq.query(
      `INSERT INTO ledger_entry (organization_id, legal_entity_id, store_id, journal, entry_date, account_code, debit_minor, credit_minor, currency, source_event_id, source_topic, reference_type, reference_id)
       SELECT organization_id, $1, NULL, 'bank', '2026-10-31', a, d, c, 'EUR', $2, 'psp.payout', 'payout', $2
         FROM legal_entity, unnest(ARRAY['1000', '1100'], ARRAY[900, 0]::bigint[], ARRAY[0, 900]::bigint[]) AS x(a, d, c)
        WHERE legal_entity.id = $1`,
      [LE_A, eventId],
    );
    const before = mock.state.moves.length;
    mock.commitThenFailNextCreate();
    const r = await syncLegalEntity(deps(), LE_A);
    expect(r).toMatchObject({ moves_created: 1, moves_found: 0, refused: [], entries_marked: 2 });
    expect(mock.state.moves.length).toBe(before + 1); // ONE move, not two
    const mine = mock.state.moves.filter((m) => m.ref === `${eventId}/bank`);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.state).toBe('posted');
    // a lost answer with NOTHING committed (a plain 5xx before the create) surfaces as a transport error, no move
    const flaky = new OdooJsonRpcClient(MOCK_ODOO_CREDENTIALS, {
      fetch: createMockOdoo({ failFirst: 1 }).fetch,
      sleep: noWait,
      retries: 0,
    });
    await expect(flaky.listCompanies()).rejects.toMatchObject({ name: 'OdooTransport' });
  });

  it('a code map and a missing Odoo account: mapped through the map, the missing code skips only its entries', async () => {
    // a third company whose chart uses other codes and lacks our 6100 (PSP fees)
    const codes = [
      ['A1000', 'Bank'],
      ['A1100', 'PSP clearing'],
      ['A1200', 'AR'],
      ['A2100', 'Carrier'],
      ['A2200', 'VAT'],
      ['A2300', 'CL goods'],
      ['A2310', 'CL shipping'],
      ['A4000', 'Rev goods'],
      ['A4010', 'Rev shipping'],
      ['A4090', 'Refunds'],
      ['A6000', 'Shipping cost'],
    ] as const;
    const mock3 = createMockOdoo({
      companies: [{ id: 3, name: 'Brand C Inc', currency: 'EUR' }],
      accounts: codes.map(([code, name]) => ({ company_id: 3, code, name })),
    });
    const odoo3 = new OdooJsonRpcClient(MOCK_ODOO_CREDENTIALS, {
      fetch: mock3.fetch,
      sleep: noWait,
    });
    // re-point legal entity A at company 3 on a fresh chart mapping (clear the mapping first; UPDATE is allowed)
    await t.hq.query('UPDATE ledger_account SET erp_account_id = NULL WHERE legal_entity_id = $1', [
      LE_A,
    ]);
    await t.hq.query(
      "UPDATE ledger_entry SET posted_to_erp_at = NULL, erp_reference = NULL WHERE legal_entity_id = $1 AND journal IN ('psp_fees', 'sales')",
      [LE_A],
    );
    await mapLegalEntityToCompany(t.hq, LE_A, 3);
    const accountCodeMap = Object.fromEntries(codes.map(([code]) => [code.slice(1), code]));
    const chart = await mapChart({ client: t.hq, erp: odoo3, log, accountCodeMap }, LE_A);
    expect(chart).toEqual({ mapped: 11, already: 0, missing: ['6100'] });
    const r = await syncLegalEntity({ client: t.hq, erp: odoo3, log, accountCodeMap }, LE_A);
    const pspGroups = await count(
      '(SELECT 1 FROM ledger_entry WHERE legal_entity_id = $1 AND journal = $2 GROUP BY source_event_id) g',
      [LE_A, 'psp_fees'],
    );
    expect(r.skipped.filter((s) => s.reason === 'account_unmapped')).toHaveLength(pspGroups);
    expect(r.skipped.every((s) => s.journal === 'psp_fees')).toBe(true);
    expect(r.moves_created).toBeGreaterThan(0);
    expect(
      await count(
        "ledger_entry WHERE legal_entity_id = $1 AND journal = 'sales' AND posted_to_erp_at IS NULL",
        [LE_A],
      ),
    ).toBe(0);
    expect(
      await count(
        "ledger_entry WHERE legal_entity_id = $1 AND journal = 'psp_fees' AND posted_to_erp_at IS NULL",
        [LE_A],
      ),
    ).toBeGreaterThan(0);
    for (const l of LOG) expect(l).not.toMatch(/email|@|line_items|title|api_key|password/i);
  });
});

// ---- live (the owner's Odoo instance: open question; skipped with the reason until ODOO_URL answers) -----------
async function probeOdoo(): Promise<string | null> {
  const url = process.env.ODOO_URL;
  if (!url) return 'ODOO_URL not set';
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/web/webclient/version_info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {}, id: 1 }),
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok ? null : `ODOO_URL answered HTTP ${res.status}`;
  } catch (err) {
    return `ODOO_URL unreachable (${(err as Error).name})`;
  }
}
const odooDown = await probeOdoo();
if (odooDown) console.warn(`erp.test: live Odoo skipped — ${odooDown}`);

describe.runIf(odooDown === null)(
  'live Odoo (ODOO_URL / ODOO_DB / ODOO_USER / ODOO_API_KEY)',
  () => {
    it('authenticates and lists companies, accounts and journals', async () => {
      const odoo = new OdooJsonRpcClient(odooCredentialsFromEnv());
      const companies = await odoo.listCompanies();
      expect(companies.length).toBeGreaterThan(0);
      const accounts = await odoo.listAccounts(companies[0]!.id);
      expect(accounts.length).toBeGreaterThan(0);
      console.info(
        `erp.test live: ${companies.length} company(ies), ${accounts.length} accounts in the first`,
      );
    });
  },
);
