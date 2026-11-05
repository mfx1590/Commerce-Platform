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
// And, on the same run (Integration 5 plan, #612):
//   gate 1 (ingest): per topic, what the relay published (the outbox rows it marked published, which it does only for
//     a send the broker acknowledged; their sum = the relay CLI's own `published`) = raw_events FINAL
//     uniqExact(event_id) = the month (the topics' high watermarks are printed as a witness); a replay of the whole outbox (the core's replayOutbox, every topic) through
//     the same group changes no count; the ingest's own `ingest_delay` (relay publish → ClickHouse ack) p95 < 10 s;
//   gate 4 (PII): every table and view of the migrated, populated ClickHouse database (sweepPii enumerates them
//     from system.tables: raw, staging, dims, facts, marts, live, ledger lines) holds 0 values shaped like an
//     e-mail, a phone, an IBAN or a card, and 0 name/address keys with a value; one planted raw e-mail is found.
// Runs in the live job only: opt-in (ANALYTICS_LIVE=1 on a laptop, with the machine; CI=true in the live job), then
// skipped with a printed reason when ClickHouse refuses the configured user or the broker is down — so the unit job
// (CI=true, no ClickHouse) skips it after one quick probe. Run it with TZ=UTC (CI is UTC) until #627 lands: the
// Finance API serves dates a day early in a non-UTC process, and this gate catches that (check 2a fails). Heavy modules load inside the suite only. Self-cleaning
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
    // gate 1 and gate 4 (filled in beforeAll)
    const delays: number[] = [];
    let perTopic: () => Promise<{
      month: Record<string, number>;
      relayed: Record<string, number>;
      watermark: Record<string, number>;
      unique: Record<string, number>;
      final: Record<string, number>;
    }>;
    let replayEverything: () => Promise<{ published: number; ingested: number; since: string }>;
    let reingestedSince: (since: string) => Promise<number>;
    let sweep: () => Promise<{
      scanned: { table: string; engine: string; columns: string[] }[];
      findings: { table: string; column: string; kind: string; count: number }[];
    }>;
    let plantRawEmail: () => Promise<void>;
    let countRows: (table: string) => Promise<number>;

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
          // the DLQ is derived from the group by createIngest (#641): `<prefix>dlq.<group>`
          topicPrefix: prefix,
          batchSize: 500,
          flushMs: 200,
          concurrency: 8,
        },
        kafka,
        sink: ingest.createRawEventsSink(ch),
        // the production topology honours customer.erased (#623); a word, not a key
        erasure: { key: 'gate5-erasure-word-only', ch },
        // gate 1: the ingest's own analytics_ingest.ingest_delay values (relay publish → ClickHouse ack), captured
        metrics: { ...ingest.createIngestMetrics(), delay: (ms: number) => void delays.push(ms) },
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
      // ---- gate 1 and gate 4 helpers (used by the its below; nothing runs here)
      const topics = [...new Set(month.events.map((e) => e.topic))].sort();
      const rowsOf = async <T>(query: string) =>
        (await ch.query({ query, format: 'JSONEachRow' })).json<T>();
      perTopic = async () => {
        const monthCounts: Record<string, number> = {};
        for (const e of month.events) monthCounts[e.topic] = (monthCounts[e.topic] ?? 0) + 1;
        // the relay's own record: it sets published_at only on the rows of an acknowledged send (relay.ts)
        const relayed: Record<string, number> = {};
        for (const r of (
          await db.owner.query<{ topic: string; n: string }>(
            'SELECT topic, count(*) AS n FROM outbox WHERE published_at IS NOT NULL GROUP BY topic',
          )
        ).rows)
          relayed[r.topic] = Number(r.n);
        // a witness only: a high watermark counts records written, a duplicate included
        const ka = kafka.admin();
        await ka.connect();
        const watermark: Record<string, number> = {};
        try {
          for (const t of topics)
            watermark[t] = (await ka.fetchTopicOffsets(`${prefix}${t}`)).reduce(
              (n, p) => n + Number(p.high) - Number(p.low),
              0,
            );
        } finally {
          await ka.disconnect();
        }
        const unique: Record<string, number> = {};
        const final: Record<string, number> = {};
        for (const r of await rowsOf<{ topic: string; u: string; n: string }>(
          'SELECT topic, uniqExact(event_id) AS u, count() AS n FROM raw_events FINAL GROUP BY topic',
        )) {
          unique[r.topic] = Number(r.u);
          final[r.topic] = Number(r.n);
        }
        return { month: monthCounts, relayed, watermark, unique, final };
      };
      reingestedSince = async (since) =>
        Number(
          (
            await rowsOf<{ n: string }>(
              `SELECT count() AS n FROM raw_events FINAL WHERE ingested_at >= toDateTime64('${since}', 3, 'UTC')`,
            )
          )[0]!.n,
        );
      replayEverything = async () => {
        const { replayOutbox } = await import('../../outbox');
        // the ingest resumes the SAME group: it sees only what the replay publishes
        const again = ingest.createIngest({
          config: {
            groupId: rawGroup,
            topicPrefix: prefix,
            batchSize: 500,
            flushMs: 200,
            concurrency: 8,
          },
          kafka,
          sink: ingest.createRawEventsSink(ch),
          erasure: { key: 'gate5-erasure-word-only', ch },
          log: () => {},
        });
        stops.push(() => again.stop());
        await again.start();
        const publisher = events.createKafkaPublisher(kafka);
        await publisher.connect();
        // the replay's rows are later than every first copy: ingested_at is the ReplacingMergeTree version
        const since = ingest.toClickHouseTime(new Date());
        let published = 0;
        try {
          for (const topic of topics)
            published += (
              await replayOutbox(hq, publisher, {
                organizationId: SEED_IDS.organization,
                topic,
                topicPrefix: prefix,
              })
            ).published;
        } finally {
          await publisher.disconnect().catch(() => {});
        }
        await until(
          () => again.stats.rows >= published,
          `${published} replayed events`,
          CEILING_MS.consume,
        );
        await again.stop();
        return { published, ingested: again.stats.rows, since };
      };
      sweep = () => ingest.sweepPii(ch);
      countRows = async (table) =>
        Number((await rowsOf<{ n: string }>(`SELECT count() AS n FROM ${table}`))[0]!.n);
      plantRawEmail = async () => {
        // a probe topic no model reads, so the raw payload is the only place the planted value can be
        await ingest.createRawEventsSink(ch).insert([
          {
            topic: 'pii.probe',
            version: 1,
            event_id: '00000000-0000-4000-8000-00000000a612',
            organization_id: SEED_IDS.organization,
            store_id: null,
            aggregate_type: 'probe',
            aggregate_id: 'probe',
            occurred_at: ingest.toClickHouseTime(new Date()),
            published_at: ingest.toClickHouseTime(new Date()),
            payload: JSON.stringify({ note: ['someone', 'shop.example'].join('@') }),
            ingested_at: ingest.toClickHouseTime(new Date()),
          },
        ]);
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
        '3b cash: captures = the ledger capture entries',
        '3c cash: payouts = bank debits',
      ]);
      // every identity compared something real (3c: the month has no PSP payouts, both sides empty)
      for (const i of r.identities.filter((x) => !x.identity.startsWith('3c')))
        expect(i.keys, i.identity).toBeGreaterThan(0);
      for (const i of r.identities) expect(i.differences, i.identity).toEqual([]);
      expect(r.ok).toBe(true);
      expect(timings.reconcile_ms).toBeLessThan(CEILING_MS.reconcile);
    });

    it("gate 1: per topic, the relay's published count = raw_events FINAL uniqExact(event_id) = the month", async () => {
      const c = await perTopic();
      console.info(
        JSON.stringify({
          test: 'gate1-counts',
          topics: Object.keys(c.month).length,
          relay_published: c.relayed,
          raw_unique_final: c.unique,
          watermark: c.watermark,
        }),
      );
      // the month's topics: order.placed, order.cancelled, payment.captured, refund.issued, shipment.shipped
      expect(Object.keys(c.month).length).toBeGreaterThanOrEqual(5);
      // the relay's per-topic record adds up to what the relay CLI itself reported, and is the month
      expect(Object.values(c.relayed).reduce((n, x) => n + x, 0)).toBe(Number(summary.relayed));
      expect(c.relayed).toEqual(c.month);
      expect(c.unique).toEqual(c.month);
      expect(c.final).toEqual(c.month);
    });

    it("gate 1: the ingest's ingest_delay (relay publish → ClickHouse ack) has p95 < 10 s", () => {
      const sorted = [...delays].sort((a, b) => a - b);
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
      console.info(
        JSON.stringify({
          test: 'gate1-lag',
          deliveries: sorted.length,
          p50_ms: Math.round(at(0.5)),
          p95_ms: Math.round(at(0.95)),
          max_ms: Math.round(sorted.at(-1)!),
        }),
      );
      expect(sorted.length).toBeGreaterThanOrEqual(Number(summary.events));
      expect(at(0.95)).toBeLessThan(10_000);
    });

    it('gate 1: a replay of the whole outbox through the same group changes no count', async () => {
      const before = await perTopic();
      const r = await replayEverything();
      const after = await perTopic();
      console.info(
        JSON.stringify({ test: 'gate1-replay', replayed: r.published, reingested: r.ingested }),
      );
      // the replay really went through: every event again, and each event's FINAL row is now the replayed copy
      expect(r.published).toBe(Number(summary.events));
      expect(await reingestedSince(r.since)).toBe(Number(summary.events));
      // … and no count moved
      expect(after.unique).toEqual(before.unique);
      expect(after.final).toEqual(before.final);
      expect(after.unique).toEqual(after.month);
    });

    it('gate 4: no table or view of the ClickHouse database holds an e-mail, phone, IBAN, card or personal-data key', async () => {
      const r = await sweep();
      const names = r.scanned.map((t) => t.table);
      console.info(
        JSON.stringify({
          test: 'gate4-pii',
          tables: names.length,
          string_columns: r.scanned.reduce((n, t) => n + t.columns.length, 0),
          findings: r.findings.length,
        }),
      );
      // every layer is in the sweep, enumerated from system.tables (a new table or model cannot be missed)
      for (const t of ['raw_events', 'ledger_lines', 'orders_minute_events', 'customer_erasures'])
        expect(names).toContain(t);
      for (const layer of ['stg_', 'dim_', 'fct_', 'mart_', 'live_'])
        expect(
          names.some((n) => n.startsWith(layer)),
          layer,
        ).toBe(true);
      // the ledger copy is populated by now (the reconcile above read it), so its bytes are swept too
      expect(await countRows('ledger_lines')).toBeGreaterThan(0);
      expect(r.findings).toEqual([]);
    });

    it('gate 4 fails when it should: one planted raw e-mail is found, where it is and nowhere else', async () => {
      await plantRawEmail();
      const r = await sweep();
      console.info(JSON.stringify({ test: 'gate4-pii-mutation', findings: r.findings }));
      expect(r.findings).toEqual([
        { table: 'raw_events', column: 'payload', kind: 'email', count: 1 },
      ]);
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
