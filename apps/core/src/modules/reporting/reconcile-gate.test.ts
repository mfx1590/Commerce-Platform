// The Integration 5 money gate (#602, D7 as amended 2026-10-25; plan §3): the generated month through the PRODUCTION
// topology, then every identity at 0 difference in minor units.
//   1. the month (@platform/test-utils: 150 orders, three legal entities incl. Brand C / USD, captures with known and
//      unknown fees, refunds of every reason, cancellations before and after partial shipments) is written to a
//      throwaway core database twice over: projected into the order / payment / refund rows the reporting views read
//      (writeMonthToCoreDb, a pure projection), and as outbox rows, as withEvents would write them;
//   2. ONE run of the core's real relay CLI (`--once --throwaway-db --topic-prefix`) publishes the outbox under a
//      throwaway prefix, and TWO fresh consumer groups read it: the real ledger (@platform/accounting,
//      createLedgerConsumer) into the same database's ledger tables, and the real ClickHouse ingest
//      (@platform/analytics-ingest) into a throwaway ClickHouse database migrated with every model;
//   3. `reconcile` reads the core's HQ reports over HTTP from the real core middleware mounted in-process (dev tokens,
//      test-only) and the Finance API over HTTP (createAccountingApi, the verifier seam), never another module's
//      tables, and every identity — bookings, recognised revenue (copy integrity, lineage, lifetime invariant) and cash
//      (captures and fees, PSP clearing, payouts) — must show 0 difference;
//   4. the gate can fail: a tampered ClickHouse ledger line and a tampered core order are both caught.
// Runs in the live job only: opt-in (ANALYTICS_LIVE=1 on a laptop, with the machine; CI=true in the live job), then
// skipped with a printed reason when ClickHouse refuses the configured user or the broker is down — so the unit job
// (CI=true, no ClickHouse) skips it after one quick probe. Heavy modules load inside the suite only. Self-cleaning
// (the database, the ClickHouse database, the prefixed topics and groups).
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CH = {
  url: process.env.CLICKHOUSE_URL?.trim() || 'http://127.0.0.1:18123',
  username: process.env.CLICKHOUSE_USER?.trim() || 'default',
  password: process.env.CLICKHOUSE_PASSWORD ?? '',
};
const BROKER = (process.env.KAFKA_BROKERS?.split(',')[0] ?? '127.0.0.1:19092').trim();

async function skipReason(): Promise<string | null> {
  if (process.env.ANALYTICS_LIVE !== '1' && process.env.CI !== 'true')
    return 'not opted in (set ANALYTICS_LIVE=1 once you hold the machine)';
  try {
    const auth = Buffer.from(`${CH.username}:${CH.password}`).toString('base64');
    const res = await fetch(`${CH.url}/?query=SELECT%201`, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(1_500),
    });
    if (!res.ok) return `ClickHouse ${CH.url}: HTTP ${res.status} for user ${CH.username}`;
  } catch (err) {
    return `ClickHouse ${CH.url}: ${(err as { cause?: { code?: string } }).cause?.code ?? (err as Error).name}`;
  }
  const [host, port] = BROKER.split(':');
  return new Promise((done) => {
    const s = net.connect({
      host: host === 'localhost' ? '127.0.0.1' : host!,
      port: Number(port),
      timeout: 1_500,
    });
    s.once('connect', () => (s.destroy(), done(null)));
    s.once('error', (e) =>
      done(`broker ${BROKER}: ${(e as NodeJS.ErrnoException).code ?? e.message}`),
    );
    s.once('timeout', () => (s.destroy(), done(`broker ${BROKER}: timeout`)));
  });
}

const skip = await skipReason();
if (skip) console.warn(`reconcile-gate.test: ${skip} — the Integration 5 money gate is skipped`);

const ORDERS = Number(process.env.RECONCILE_GATE_ORDERS ?? 150);
const WINDOW = { from: '2026-10-01', to: '2026-11-01' };
// Ceilings ≥ 5× what the machine measured; the assertions are the identities, durations are ceilings only.
const CEILING_MS = { relay: 60_000, consume: 120_000, reconcile: 60_000 };

describe.runIf(skip === null)(
  'Integration 5 gate: the generated month through the real relay, ledger and ingest, every identity at 0',
  () => {
    const run = Math.random().toString(36).slice(2, 8);
    const prefix = `gate5-${run}.`;
    const coreDir = fileURLToPath(new URL('../../..', import.meta.url));
    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
    const timings: Record<string, number> = {};
    const stops: (() => Promise<unknown>)[] = [];
    let cleanup: () => Promise<void> = async () => {};
    // filled in beforeAll (dynamic imports: the unit job never loads these modules)
    let reconcileOnce: () => Promise<{
      ok: boolean;
      text: string;
      identities: { identity: string; keys: number; differences: unknown[] }[];
    }>;
    let tamperLedgerCopy: () => Promise<void>;
    let tamperCoreOrder: () => Promise<void>;
    let summary: Record<string, unknown> = {};

    const until = async (cond: () => boolean, what: string, ms: number) => {
      const t0 = Date.now();
      while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    };

    beforeAll(async () => {
      const [{ createOrganizationClient, seed, SEED_IDS }, { createTestDatabase }] =
        await Promise.all([import('@platform/db'), import('@platform/db/testing')]);
      const events = await import('@platform/events');
      const testUtils = await import('@platform/test-utils');
      const accounting = await import('@platform/accounting');
      const ingest = await import('@platform/analytics-ingest');
      const express = (await import('express')).default;
      const { DevTokenVerifier, coreErrorHandler, moduleAdminRouters } = await import('../../http');
      const { initDb, closePool } = await import('../../lib/db');
      const { mountCoreMiddleware } = await import('../../server');
      const { withEvents } = await import('../../outbox');

      // ---- 1. the month into a throwaway core database: projected rows + outbox rows
      const db = await createTestDatabase('reconcile_test');
      const chDatabase = `analytics_test_${run}`;
      const chAdmin = ingest.createChClient({ ...CH, database: 'default' }, 'default');
      const ch = ingest.createChClient({ ...CH, database: chDatabase }, chDatabase);
      const kafka = events.createKafka({ clientId: `reconcile-gate-${run}` });
      cleanup = async () => {
        for (const stop of stops) await stop().catch(() => {});
        await closePool().catch(() => {});
        const admin = kafka.admin();
        await admin.connect().catch(() => {});
        try {
          const mine = (await admin.listTopics()).filter((t) => t.startsWith(prefix));
          if (mine.length) await admin.deleteTopics({ topics: mine, timeout: 30_000 });
          const groups = (await admin.listGroups()).groups
            .map((g) => g.groupId)
            .filter((g) => g.startsWith(prefix));
          if (groups.length) await admin.deleteGroups(groups).catch(() => {});
        } catch {
          /* the broker may be gone; the databases are still dropped below */
        } finally {
          await admin.disconnect().catch(() => {});
        }
        await chAdmin.command({ query: `DROP DATABASE IF EXISTS ${chDatabase}` }).catch(() => {});
        await Promise.allSettled([chAdmin.close(), ch.close()]);
        await db.drop();
      };
      await seed(db.owner, { productsPerStore: 2, log: () => {} });
      const hq = createOrganizationClient(db.app, {
        organizationId: SEED_IDS.organization,
        actorId: null,
      });
      const month = testUtils.generateMonth({
        orders: ORDERS,
        seed: 6020,
        deterministicIds: true,
        legalEntities: 3,
        ordersPerDay: Math.max(1, Math.floor(ORDERS / 27)),
      });
      const projected = await testUtils.writeMonthToCoreDb(db.owner, month.events);
      // the outbox's one writer (ADR 0003): withEvents validates each envelope and writes its row
      await hq.transaction((tx) => withEvents(tx, month.events as never));

      // ---- 2. prefixed topics, the ClickHouse schema, both consumers, ONE real relay run
      const policy = JSON.parse(
        readFileSync(
          fileURLToPath(
            new URL('../../../../../infra/redpanda/topics.policy.json', import.meta.url),
          ),
          'utf8',
        ),
      ) as Parameters<typeof events.planTopics>[0];
      const ka = kafka.admin();
      await ka.connect();
      await events.ensureTopics(
        ka,
        events.planTopics(policy, { environment: 'ci', prefix }).filter((t) => t.kind === 'event'),
      );
      await ka.disconnect();
      await ingest.migrate(chAdmin, ch, chDatabase, ingest.readSqlFiles());

      const quiet = { info: () => {}, warn: () => {}, error: () => {} };
      const ledger = accounting.createLedgerConsumer({
        client: hq,
        kafka,
        topicPrefix: prefix,
        groupId: `${prefix}${accounting.LEDGER_GROUP}`,
        fromBeginning: true,
        log: quiet,
      });
      stops.push(() => ledger.stop());
      const rawGroup = `${prefix}${ingest.DEFAULT_GROUP}`;
      const raw = ingest.createIngest({
        config: {
          groupId: rawGroup,
          dlqTopic: `${prefix}${events.dlqTopicName(rawGroup)}`,
          topicPrefix: prefix,
          batchSize: 500,
          flushMs: 200,
          concurrency: 8,
        },
        kafka,
        sink: ingest.createRawEventsSink(ch),
        log: () => {},
      });
      stops.push(() => raw.stop());
      await ledger.start();
      await raw.start();

      const t0 = Date.now();
      const relayed = await new Promise<Record<string, unknown>>((done, fail) => {
        const url = new URL(process.env.DATABASE_URL_APP!);
        url.pathname = `/${db.name}`;
        execFile(
          process.execPath,
          [
            tsxCli,
            'src/outbox/relay-cli.ts',
            '--once',
            '--throwaway-db',
            '--batch',
            String(month.events.length + 1),
            '--no-registry',
            '--topic-prefix',
            prefix,
          ],
          {
            cwd: coreDir,
            env: {
              ...process.env,
              DATABASE_URL_APP: url.toString(),
              CORE_ORGANIZATION_ID: SEED_IDS.organization,
            },
            timeout: CEILING_MS.relay,
            maxBuffer: 16 * 1024 * 1024,
          },
          (err, stdout, stderr) => {
            if (err) return fail(new Error(`relay-cli failed: ${String(stderr).slice(-2000)}`));
            done(
              JSON.parse(String(stdout).trim().split('\n').at(-1) ?? '{}') as Record<
                string,
                unknown
              >,
            );
          },
        );
      });
      timings.relay_ms = Date.now() - t0;
      const ledgerEvents = month.events.filter((e) =>
        (accounting.LEDGER_TOPICS as readonly string[]).includes(e.topic),
      ).length;
      const t1 = Date.now();
      await until(
        () => ledger.stats.handled >= ledgerEvents,
        `${ledgerEvents} ledger events`,
        CEILING_MS.consume,
      );
      await until(
        () => raw.stats.rows >= month.events.length,
        `${month.events.length} raw events`,
        CEILING_MS.consume,
      );
      timings.consume_ms = Date.now() - t1;
      await ledger.stop();
      await raw.stop();

      // ---- 3. the two public APIs over HTTP, in-process
      process.env.CORE_DEV_TOKENS = '1';
      await initDb({ connectionString: db.app.options.connectionString! });
      const core = express();
      mountCoreMiddleware(core, new DevTokenVerifier(), { moduleRouters: moduleAdminRouters() });
      core.use(coreErrorHandler);
      const coreServer: Server = await new Promise((r) => {
        const s = core.listen(0, '127.0.0.1', () => r(s));
      });
      stops.push(() => new Promise((r) => coreServer.close(() => r(undefined))));
      // the Finance API: the token IS the seeded subject; the permission seam grants finance to finance and owner
      const granted = new Set<string>([SEED_IDS.users.finance, SEED_IDS.users.owner]);
      const financeApi = accounting.createAccountingApi({
        client: hq,
        auth: accounting.createFinanceAuth({
          client: hq,
          devTokens: false,
          verifier: { verify: async (token: string) => ({ subject: token }) },
          permission: async (staffUserId: string, relation: string, object: string) =>
            relation === 'finance' && object === 'organization:hq' && granted.has(staffUserId),
        }),
        log: quiet,
      });
      const financeServer = createServer((req, res) => {
        void financeApi(req, res).then((handled) => {
          if (!handled) {
            res.writeHead(404);
            res.end();
          }
        });
      });
      await new Promise<void>((r) => financeServer.listen(0, '127.0.0.1', r));
      stops.push(() => new Promise((r) => financeServer.close(() => r(undefined))));
      const port = (s: Server) => (s.address() as AddressInfo).port;
      const finance = ingest.createFinanceClient({
        baseUrl: `http://127.0.0.1:${port(financeServer)}`,
        token: 'seed-finance',
      });
      const admin = ingest.createAdminReportsClient({
        baseUrl: `http://127.0.0.1:${port(coreServer)}`,
        token: 'dev:seed-owner',
      });

      reconcileOnce = async () => {
        const t = Date.now();
        const r = await ingest.reconcile({ ch, finance, admin, window: WINDOW });
        timings.reconcile_ms = Date.now() - t;
        return { ok: r.ok, text: ingest.renderReport(r), identities: r.identities };
      };
      tamperLedgerCopy = async () => {
        // a line ClickHouse has and the ledger never posted: copy integrity and lineage must both see it
        await ch.command({
          query: `INSERT INTO ledger_lines SELECT generateUUIDv4(), legal_entity_id, store_id, journal, entry_date, account_code, debit_minor, credit_minor + 1, currency, generateUUIDv4(), source_topic, reference_type, reference_id, now64(3) FROM ledger_lines WHERE account_code = '4000' LIMIT 1`,
        });
      };
      tamperCoreOrder = async () => {
        await db.owner.query(
          `UPDATE "order" SET total_minor = total_minor + 1 WHERE id = (SELECT id FROM "order" WHERE status <> 'cancelled' AND payment_status <> 'failed' ORDER BY id LIMIT 1)`,
        );
      };
      summary = {
        test: 'reconcile-gate',
        orders: ORDERS,
        events: month.events.length,
        ledger_events: ledgerEvents,
        projected,
        relayed: relayed.published,
        ledger_dead_lettered: ledger.stats.dead_lettered,
        raw_rows: raw.stats.rows,
        raw_dead_lettered: raw.stats.dead_lettered,
      };
      console.info(JSON.stringify(summary));
    }, 600_000);

    afterAll(async () => {
      try {
        await cleanup();
      } finally {
        console.info(JSON.stringify({ test: 'reconcile-gate', ...timings }));
      }
    }, 180_000);

    it('every event reached both consumers once: relayed all, nothing dead-lettered', () => {
      expect(summary.relayed).toBe(summary.events);
      expect(summary.ledger_dead_lettered).toBe(0);
      expect(summary.raw_rows).toBe(summary.events);
      expect(summary.raw_dead_lettered).toBe(0);
    });

    it('bookings, recognised revenue and cash: every identity shows 0 difference in minor units', async () => {
      const r = await reconcileOnce();
      console.info(r.text);
      expect(r.identities.map((i) => i.identity)).toEqual([
        '1 bookings',
        '2a recognised: copy integrity (lines)',
        '2a recognised: copy integrity (trial balance)',
        '2b recognised: lineage',
        '2c recognised: lifetime invariant',
        '3a cash: captures and fees',
        '3b cash: captures = PSP clearing debits',
        '3c cash: payouts = bank debits',
      ]);
      // every identity compared something real (3c: the month has no PSP payouts, both sides empty)
      for (const i of r.identities.filter((x) => !x.identity.startsWith('3c')))
        expect(i.keys, i.identity).toBeGreaterThan(0);
      for (const i of r.identities) expect(i.differences, i.identity).toEqual([]);
      expect(r.ok).toBe(true);
      expect(timings.reconcile_ms).toBeLessThan(CEILING_MS.reconcile);
    });

    it('the gate fails when it should: a forged ClickHouse ledger line and a changed core order are both caught', async () => {
      await tamperLedgerCopy();
      await tamperCoreOrder();
      const r = await reconcileOnce();
      const failing = r.identities.filter((i) => i.differences.length > 0).map((i) => i.identity);
      expect(r.ok).toBe(false);
      expect(failing).toEqual(
        expect.arrayContaining([
          '1 bookings',
          '2a recognised: copy integrity (lines)',
          '2a recognised: copy integrity (trial balance)',
          '2b recognised: lineage',
        ]),
      );
    });
  },
);
