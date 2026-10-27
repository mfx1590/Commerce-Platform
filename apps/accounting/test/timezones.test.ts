// #627: every date the service serves or sends must be the same in any process time zone. node-postgres parses a
// `date` column as LOCAL midnight, so formatting that Date shifted every day one day EARLY east of UTC (found by the
// Integration 5 money gate at UTC+2). The service now selects every date column ::text. This file runs the Finance read
// API and the Odoo sync (mock) under UTC, Asia/Tokyo (UTC+9) and America/Los_Angeles (UTC−7/−8) — both sides of UTC —
// and asserts identical answers, equal to the database's own `::text` dates. Node applies `process.env.TZ` at runtime;
// a sanity check proves the zone really changed and that an UNCAST `date` read still reproduces the bug, so a pass
// here cannot be vacuous. Vitest runs files in forked processes one at a time (fileParallelism: false), and the
// zone is restored after each test.
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { SEED_IDS } from '@platform/db';
import type { EventEnvelopeV1Base } from '@platform/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFinanceAuth } from '../src/api/auth.js';
import { createAccountingApi } from '../src/api/server.js';
import { handleLedgerEvent } from '../src/consumer.js';
import { createMockOdoo, MOCK_ODOO_CREDENTIALS } from '../src/erp/mock.js';
import { OdooJsonRpcClient } from '../src/erp/odoo-jsonrpc.js';
import { mapChart, mapLegalEntityToCompany, syncLegalEntity } from '../src/erp/sync.js';
import type { Logger } from '../src/log.js';
import { LE_A } from '../src/posting/fixtures.js';
import { FIXTURES_DIR } from '../src/reconcile/fixtures/write.js';
import { reconcileAll } from '../src/reconcile/reconcile.js';
import { createFixtureSource, loadFixtureDir } from '../src/reconcile/source-fixture.js';
import { createAccountingTestDatabase, type AccountingTestDatabase } from './helpers/db.js';

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const ZONES = ['UTC', 'Asia/Tokyo', 'America/Los_Angeles'] as const;
/** minutes WEST of UTC on 2026-10-01 local (getTimezoneOffset), to prove the zone took effect */
const OFFSET: Record<(typeof ZONES)[number], number> = {
  UTC: 0,
  'Asia/Tokyo': -540,
  'America/Los_Angeles': 420,
};
const ORIGINAL_TZ = process.env.TZ;
const inZone = async <T>(zone: (typeof ZONES)[number], fn: () => Promise<T>): Promise<T> => {
  process.env.TZ = zone;
  try {
    expect(new Date(2026, 9, 1).getTimezoneOffset(), zone).toBe(OFFSET[zone]);
    return await fn();
  } finally {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  }
};

let t: AccountingTestDatabase;
let server: Server;
let base: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON bodies, as in api.test.ts
type Json = any;

async function get(pathname: string): Promise<Json> {
  const res = await fetch(`${base}${pathname}`, {
    headers: { authorization: 'Bearer seed-finance' },
  });
  expect(res.status, pathname).toBe(200);
  return res.json();
}

/** Every date-bearing answer of the API for legal entity A: books, all journal lines, payouts and their lines, ERP status. */
async function apiSnapshot() {
  const books = (await get('/accounting/v1/legal-entities')).items;
  const lines: Json[] = [];
  for (let page = 1; ; page++) {
    const r = await get(
      `/accounting/v1/legal-entities/${LE_A}/journal-lines?limit=100&page=${page}`,
    );
    lines.push(...r.items);
    if (page * r.limit >= r.total) break;
  }
  const filtered = await get(
    `/accounting/v1/legal-entities/${LE_A}/journal-lines?from=2026-10-01&to=2026-10-01&limit=100`,
  );
  const payouts = (await get(`/accounting/v1/legal-entities/${LE_A}/payouts?limit=100`)).items;
  const firstPayout = await get(
    `/accounting/v1/legal-entities/${LE_A}/payouts/${payouts[0].id}?limit=100`,
  );
  const erp = await get(`/accounting/v1/legal-entities/${LE_A}/erp-status`);
  return { books, lines, filtered, payouts, firstPayout, erp };
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
  const deps = { client: t.hq, source: createFixtureSource(files), log: quiet };
  for (const f of files) await reconcileAll(deps, f.legal_entity_id);
  const auth = createFinanceAuth({
    client: t.hq,
    devTokens: false,
    verifier: { verify: async (token) => ({ subject: token }) },
    permission: async (staffUserId) => staffUserId === SEED_IDS.users.finance,
  });
  const api = createAccountingApi({ client: t.hq, auth, log: quiet });
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

describe('dates are the same in every process time zone (#627)', () => {
  it('the test really changes the zone: an UNCAST date column read at UTC+9 is a day early (the bug, reproduced)', async () => {
    const r = await inZone('Asia/Tokyo', () =>
      t.hq.query<{ raw: Date; text: string }>(
        'SELECT entry_date AS raw, entry_date::text AS text FROM ledger_entry ORDER BY entry_date LIMIT 1',
      ),
    );
    const { raw, text } = r.rows[0]!;
    expect(raw).toBeInstanceOf(Date);
    expect(raw.toISOString().slice(0, 10)).not.toBe(text); // what queries.ts used to serve
  });

  it('the Finance read API serves identical dates under UTC, Asia/Tokyo and America/Los_Angeles, equal to the database', async () => {
    const snapshots: Record<string, Awaited<ReturnType<typeof apiSnapshot>>> = {};
    for (const zone of ZONES) snapshots[zone] = await inZone(zone, apiSnapshot);
    for (const zone of ZONES) expect(snapshots[zone], zone).toEqual(snapshots.UTC);

    const truth = await t.hq.query<{ id: string; d: string }>(
      'SELECT id, entry_date::text AS d FROM ledger_entry WHERE legal_entity_id = $1',
      [LE_A],
    );
    const byId = new Map(truth.rows.map((r) => [r.id, r.d]));
    const s = snapshots['Asia/Tokyo']!;
    expect(s.lines.length).toBe(truth.rows.length);
    for (const l of s.lines) expect(l.entry_date, l.id).toBe(byId.get(l.id));
    const a = s.books.find((b: Json) => b.legal_entity_id === LE_A);
    const days = [...byId.values()].sort();
    expect([a.first_entry_date, a.last_entry_date]).toEqual([days[0], days.at(-1)]);
    // the period filter (in SQL) and the served dates agree: every line of 2026-10-01 is dated 2026-10-01
    expect(s.filtered.items.length).toBe(days.filter((d) => d === '2026-10-01').length);
    expect(s.filtered.items.every((l: Json) => l.entry_date === '2026-10-01')).toBe(true);
    const payouts = await t.hq.query<{ id: string; d: string }>(
      'SELECT id, arrival_date::text AS d FROM psp_payout WHERE legal_entity_id = $1',
      [LE_A],
    );
    const arrival = new Map(payouts.rows.map((r) => [r.id, r.d]));
    for (const p of s.payouts) expect(p.arrival_date, p.id).toBe(arrival.get(p.id));
    const avail = await t.hq.query<{ id: string; d: string | null }>(
      'SELECT id, available_on::text AS d FROM psp_payout_line WHERE payout_id = $1',
      [s.payouts[0].id],
    );
    const availById = new Map(avail.rows.map((r) => [r.id, r.d]));
    for (const l of s.firstPayout.lines.items)
      expect(l.available_on, l.id).toBe(availById.get(l.id));
    expect(s.erp.oldest_unposted_entry_date).toBe(days[0]); // nothing synced yet
  });

  it('the Odoo sync sends each move dated with its entry date under all three zones (the books in Odoo)', async () => {
    const truth = await t.hq.query<{ ref: string; d: string }>(
      `SELECT DISTINCT source_event_id::text || '/' || journal AS ref, entry_date::text AS d
         FROM ledger_entry WHERE legal_entity_id = $1`,
      [LE_A],
    );
    const expected = Object.fromEntries(truth.rows.map((r) => [r.ref, r.d]));
    for (const zone of ZONES) {
      // a fresh Odoo per zone; the rows are un-marked first (owner pool: a test reset, never the service)
      await t.db.owner.query(
        'UPDATE ledger_entry SET posted_to_erp_at = NULL, erp_reference = NULL WHERE legal_entity_id = $1',
        [LE_A],
      );
      const mock = createMockOdoo();
      const odoo = new OdooJsonRpcClient(MOCK_ODOO_CREDENTIALS, {
        fetch: mock.fetch,
        sleep: async () => {},
      });
      const deps = { client: t.hq, erp: odoo, log: quiet, batchSize: 100 };
      const r = await inZone(zone, async () => {
        await mapLegalEntityToCompany(t.hq, LE_A, 1);
        await mapChart(deps, LE_A);
        return syncLegalEntity(deps, LE_A);
      });
      expect(r, zone).toMatchObject({ refused: [], skipped: [], moves_created: truth.rows.length });
      expect(Object.fromEntries(mock.state.moves.map((m) => [m.ref, m.date])), zone).toEqual(
        expected,
      );
    }
  });
});
