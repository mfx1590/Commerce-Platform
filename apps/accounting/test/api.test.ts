// The Finance read API over HTTP on a seeded database with the clean-month ledger and its payouts (#551): 401 without
// a token, 403 for a store admin (two stores) and an analyst with the contract's details, 200 for finance and owner on
// every operation with bodies that validate against the contract's schemas, 404 for a foreign legal entity, 400 for
// a bad query, and the trial balance's totals at zero.
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { SEED_IDS } from '@platform/db';
import type { EventEnvelopeV1Base } from '@platform/events';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFinanceAuth } from '../src/api/auth.js';
import { createAccountingApi } from '../src/api/server.js';
import { loadApiSpec } from '../src/api/spec.js';
import { handleLedgerEvent } from '../src/consumer.js';
import type { Logger } from '../src/log.js';
import { LE_A, LE_B } from '../src/posting/fixtures.js';
import { FIXTURES_DIR } from '../src/reconcile/fixtures/write.js';
import { reconcileAll } from '../src/reconcile/reconcile.js';
import { createFixtureSource, loadFixtureDir } from '../src/reconcile/source-fixture.js';
import { createAccountingTestDatabase, type AccountingTestDatabase } from './helpers/db.js';

const LOG: string[] = [];
const log: Logger = {
  info: (l) => LOG.push(JSON.stringify(l)),
  warn: (l) => LOG.push(JSON.stringify(l)),
  error: (l) => LOG.push(JSON.stringify(l)),
};

// seeded staff subjects (packages/db seed): the token IS the subject here; the permission seam plays OpenFGA
const SUBJECTS = {
  finance: 'seed-finance',
  owner: 'seed-owner',
  storeAdmin: 'seed-store-admin',
  analyst: 'seed-analyst',
} as const;
const GRANTED = new Set<string>([SEED_IDS.users.finance, SEED_IDS.users.owner]);

// ajv and ajv-formats ship CJS default exports; under NodeNext ESM they may arrive wrapped (packages/events does the same)
const unwrap = <T>(m: T): T => (m as { default?: T }).default ?? m;
type Validator = ((data: unknown) => boolean) & { errors?: unknown };
const Ajv2020 = unwrap(Ajv2020Module) as unknown as new (opts: object) => {
  addSchema(schema: unknown, key: string): void;
  getSchema(key: string): Validator | undefined;
};
const addFormats = unwrap(addFormatsModule) as unknown as (ajv: object) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let t: AccountingTestDatabase;
let server: Server;
let base: string;
const spec = loadApiSpec();
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(spec.document, 'spec');
const validate = (schema: string, body: unknown) => {
  const v = ajv.getSchema(`spec#/components/schemas/${schema}`)!;
  const ok = v(body);
  expect(ok, `${schema}: ${JSON.stringify(v.errors)}`).toBe(true);
};

async function get(pathname: string, token?: string): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${base}${pathname}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json() };
}

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
  const files = await loadFixtureDir(path.join(FIXTURES_DIR, 'clean-month'));
  const deps = { client: t.hq, source: createFixtureSource(files), log };
  for (const f of files) await reconcileAll(deps, f.legal_entity_id);

  const auth = createFinanceAuth({
    client: t.hq,
    devTokens: false,
    verifier: { verify: async (token) => ({ subject: token }) },
    permission: async (staffUserId, relation, object) =>
      relation === 'finance' && object === 'organization:hq' && GRANTED.has(staffUserId),
  });
  const api = createAccountingApi({ client: t.hq, auth, spec, log });
  server = createServer((req, res) => {
    void api(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 240_000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await t?.drop();
});

describe('authentication and authorization', () => {
  it('no token → 401; unknown subject → 401; store admin and analyst → 403 with the relation and object; finance and owner → 200', async () => {
    const path = `/accounting/v1/legal-entities/${LE_A}/trial-balance`;
    expect((await get(path)).status).toBe(401);
    expect((await get(path, 'nobody-here')).status).toBe(401);
    for (const who of [SUBJECTS.storeAdmin, SUBJECTS.analyst] as string[]) {
      const r = await get(path, who);
      expect(r.status).toBe(403);
      expect(r.body).toEqual({
        code: 'forbidden',
        message: 'Not allowed',
        details: { relation: 'finance', object: 'organization:hq' },
      });
      validate('Error', r.body);
    }
    expect((await get(path, SUBJECTS.finance)).status).toBe(200);
    expect((await get(path, SUBJECTS.owner)).status).toBe(200);
  });

  it('every operation refuses a store admin and serves finance', async () => {
    const payouts = await get(`/accounting/v1/legal-entities/${LE_A}/payouts`, SUBJECTS.finance);
    const payoutId = payouts.body.items[0].id as string;
    const paths = [
      '/accounting/v1/legal-entities',
      `/accounting/v1/legal-entities/${LE_A}/trial-balance`,
      `/accounting/v1/legal-entities/${LE_A}/journal-lines`,
      `/accounting/v1/legal-entities/${LE_A}/parked-events`,
      `/accounting/v1/legal-entities/${LE_A}/payouts`,
      `/accounting/v1/legal-entities/${LE_A}/payouts/${payoutId}`,
      `/accounting/v1/legal-entities/${LE_A}/erp-status`,
    ];
    for (const p of paths) {
      expect((await get(p, SUBJECTS.storeAdmin)).status, p).toBe(403);
      expect((await get(p, SUBJECTS.finance)).status, p).toBe(200);
    }
    expect(LOG.some((l) => l.includes('"status":403'))).toBe(true);
    for (const l of LOG) expect(l).not.toMatch(/email|@|seed-|Bearer|items/);
  });
});

describe('the reads', () => {
  it('books: both legal entities with their currencies and counts', async () => {
    const r = await get('/accounting/v1/legal-entities', SUBJECTS.finance);
    expect(r.status).toBe(200);
    for (const item of r.body.items) validate('LegalEntityBooks', item);
    const a = r.body.items.find((x: { legal_entity_id: string }) => x.legal_entity_id === LE_A);
    expect(a).toMatchObject({
      code: 'le-brand-a',
      reporting_currency: 'EUR',
      currencies: ['EUR'],
      odoo_company_id: null,
    });
    expect(a.entries).toBeGreaterThan(100);
    expect(a.unposted_entries).toBe(a.entries);
  });

  it('trial balance: balanced per currency, rows carry account names; period and currency filters apply', async () => {
    const r = await get(`/accounting/v1/legal-entities/${LE_B}/trial-balance`, SUBJECTS.finance);
    expect(r.status).toBe(200);
    validate('TrialBalance', r.body);
    expect(r.body.totals).toEqual([
      {
        currency: 'GBP',
        debit_minor: expect.any(Number),
        credit_minor: expect.any(Number),
        difference_minor: 0,
      },
    ]);
    expect(
      r.body.rows.find((x: { account_code: string }) => x.account_code === '1000'),
    ).toMatchObject({ account_name: 'Bank', account_type: 'asset' });
    const narrowed = await get(
      `/accounting/v1/legal-entities/${LE_B}/trial-balance?from=2026-10-01&to=2026-10-07&currency=GBP`,
      SUBJECTS.finance,
    );
    expect(narrowed.body.totals[0].difference_minor).toBe(0);
    expect(narrowed.body.totals[0].debit_minor).toBeLessThan(r.body.totals[0].debit_minor);
    const none = await get(
      `/accounting/v1/legal-entities/${LE_B}/trial-balance?currency=EUR`,
      SUBJECTS.finance,
    );
    expect(none.body.rows).toEqual([]);
  });

  it('journal lines: paginated, filtered by journal / reference / erp state; bank lines have store_id null', async () => {
    const page1 = await get(
      `/accounting/v1/legal-entities/${LE_A}/journal-lines?limit=5`,
      SUBJECTS.finance,
    );
    expect(page1.status).toBe(200);
    validate('JournalLinePage', page1.body);
    expect(page1.body.items).toHaveLength(5);
    expect(page1.body.total).toBeGreaterThan(5);
    const page2 = await get(
      `/accounting/v1/legal-entities/${LE_A}/journal-lines?limit=5&page=2`,
      SUBJECTS.finance,
    );
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
    const bank = await get(
      `/accounting/v1/legal-entities/${LE_A}/journal-lines?journal=bank`,
      SUBJECTS.finance,
    );
    expect(bank.body.total).toBe(8);
    expect(
      bank.body.items.every(
        (l: { store_id: string | null; reference_type: string }) =>
          l.store_id === null && l.reference_type === 'payout',
      ),
    ).toBe(true);
    const ref = page1.body.items[0];
    const byRef = await get(
      `/accounting/v1/legal-entities/${LE_A}/journal-lines?reference_type=${ref.reference_type}&reference_id=${ref.reference_id}`,
      SUBJECTS.finance,
    );
    expect(
      byRef.body.items.every((l: { reference_id: string }) => l.reference_id === ref.reference_id),
    ).toBe(true);
    const posted = await get(
      `/accounting/v1/legal-entities/${LE_A}/journal-lines?erp=posted`,
      SUBJECTS.finance,
    );
    expect(posted.body.total).toBe(0);
  });

  it('payouts: the list, one payout with its lines, the ERP status, the parked events', async () => {
    const list = await get(
      `/accounting/v1/legal-entities/${LE_A}/payouts?status=reconciled`,
      SUBJECTS.finance,
    );
    expect(list.status).toBe(200);
    validate('PayoutPage', list.body);
    expect(list.body.total).toBe(4);
    expect(
      list.body.items.every(
        (p: { discrepancy_count: number; posted_at: string | null }) =>
          p.discrepancy_count === 0 && p.posted_at !== null,
      ),
    ).toBe(true);
    const one = await get(
      `/accounting/v1/legal-entities/${LE_A}/payouts/${list.body.items[0].id}`,
      SUBJECTS.finance,
    );
    validate('PayoutDetail', one.body);
    expect(one.body.lines.total).toBe(one.body.line_count);
    expect(one.body.lines.items.length).toBe(Math.min(one.body.line_count, 20));
    expect(
      one.body.lines.items.every((l: { match_status: string }) => l.match_status === 'matched'),
    ).toBe(true);
    const second = await get(
      `/accounting/v1/legal-entities/${LE_A}/payouts/${list.body.items[0].id}?limit=1&page=2`,
      SUBJECTS.finance,
    );
    validate('PayoutDetail', second.body);
    expect(second.body.lines).toMatchObject({ page: 2, limit: 1, total: one.body.line_count });
    expect(second.body.lines.items).toHaveLength(1);
    expect(second.body.lines.items[0].id).not.toBe(one.body.lines.items[0].id);
    const erp = await get(`/accounting/v1/legal-entities/${LE_A}/erp-status`, SUBJECTS.finance);
    validate('ErpSyncStatus', erp.body);
    expect(erp.body).toMatchObject({
      odoo_company_id: null,
      chart: { accounts: 12, mapped: 0, unmapped_codes: expect.any(Array) },
      posted_entries: 0,
    });
    expect(erp.body.chart.unmapped_codes).toHaveLength(12);
    const parked = await get(
      `/accounting/v1/legal-entities/${LE_A}/parked-events`,
      SUBJECTS.finance,
    );
    validate('ParkedEventPage', parked.body);
    expect(parked.body.total).toBe(0);
  });

  it('404 for a legal entity or payout outside the organization, 400 for a bad or unknown query parameter', async () => {
    const foreign = '00000000-0000-4000-8000-0000000000ff';
    expect(
      (await get(`/accounting/v1/legal-entities/${foreign}/trial-balance`, SUBJECTS.finance))
        .status,
    ).toBe(404);
    expect(
      (await get(`/accounting/v1/legal-entities/${LE_A}/payouts/${foreign}`, SUBJECTS.finance))
        .status,
    ).toBe(404);
    const bad = await get(
      `/accounting/v1/legal-entities/${LE_A}/journal-lines?limit=999&from=yesterday&nope=1`,
      SUBJECTS.finance,
    );
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({
      code: 'validation_error',
      details: { limit: expect.any(String), from: expect.any(String), nope: 'unknown parameter' },
    });
    expect((await get('/accounting/v1/nothing', SUBJECTS.finance)).status).toBe(404);
  });
});
