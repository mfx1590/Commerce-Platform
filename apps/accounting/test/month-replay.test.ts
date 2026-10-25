// The Integration 4 accounting gate (#552): a generated month — three legal entities, three stores, three currencies,
// orders, captures with fees, partial and full refunds, cancellations, partial and full shipments — written as outbox
// rows, relayed onto the bus by the REAL relay (apps/core's `outbox:relay --once --topic-prefix <p> --throwaway-db
// --no-registry`, spawned against the throwaway database), consumed live by one `accounting.ledger` group into one
// ledger, then REPLAYED by the REAL `outbox:replay --topic <t> --topic-prefix <p>` (one process per topic, shipments,
// refunds, cancellations and captures first, orders last on purpose) into a FRESH group and a FRESH database:
//   (1) the trial balance is zero per legal entity per currency, and the replayed ledger equals the live one,
//   (2) the month's payout reports reconcile with zero differences,
//   (3) a second replay into the same group changes nothing.
// Since #594 / #595 the test no longer reproduces the relay and the replay with @platform/events' wire functions
// (`outboxRowToEnvelope` + `envelopeToMessage`, the accepted deviation until #579): it spawns both CLIs, so the gate
// covers their row selection, seq order, marking, headers and replay headers too. Every topic of the policy exists
// under the run's prefix (the relay's start-up check requires them); nothing touches the real topic names.
// Counts and balances are the assertions; durations are ceilings only (both in the comment at the bottom; relay and
// replay now include process start-up). Skipped with a printed reason when the broker is down. Self-cleaning
// (prefixed topics and groups, the two throwaway databases).
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { SEED_IDS } from '@platform/db';
import {
  brokersFromEnv,
  createKafka,
  ensureTopics,
  planTopics,
  toOutboxRow,
  type EventConsumer,
  type EventEnvelope,
  type EventEnvelopeV1Base,
  type TopicPolicy,
} from '@platform/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLedgerConsumer, LEDGER_GROUP, PROCESSED_TABLE } from '../src/consumer.js';
import { balanceByCurrency, trialBalance } from '../src/ledger.js';
import type { Logger } from '../src/log.js';
import { generateMonth, LE_A, LE_B, LE_C } from '../src/posting/fixtures.js';
import { LEDGER_TOPICS } from '../src/posting/index.js';
import { payoutReportFor } from '../src/reconcile/fixtures/build.js';
import { pspClearingBalance, reconcileAll } from '../src/reconcile/reconcile.js';
import { createFixtureSource } from '../src/reconcile/source-fixture.js';
import { createAccountingTestDatabase, type AccountingTestDatabase } from './helpers/db.js';

const ORDERS = Number(process.env.MONTH_REPLAY_ORDERS ?? 150);
// Ceilings ≥ 5× the local medians (three runs, 150 orders = 556 events, 2026-10-23, this laptop):
//   relay 1,009 ms · consume 14,828 ms · replay 211 ms · replay_consume 13,206 ms · reconcile 364 ms
const CEILING_MS = {
  relay: 60_000,
  consume: 120_000,
  replay: 60_000,
  replay_consume: 120_000,
  reconcile: 30_000,
};

async function probeBroker(): Promise<string | null> {
  const [hostPort] = brokersFromEnv();
  const [host, port] = hostPort!.split(':');
  return new Promise((done) => {
    const s = net.connect({
      host: host === 'localhost' ? '127.0.0.1' : host!,
      port: Number(port),
      timeout: 1500,
    });
    s.once('connect', () => (s.destroy(), done(null)));
    s.once('error', (e) => done(`${hostPort}: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
    s.once('timeout', () => (s.destroy(), done(`${hostPort}: timeout`)));
  });
}
const brokerDown = await probeBroker();
if (brokerDown)
  console.warn(
    `month-replay.test: broker ${brokerDown} — the Integration 4 gate is skipped (pnpm compose:up)`,
  );

describe.runIf(brokerDown === null)(
  'Integration 4 gate: a generated month replayed into a fresh accounting.ledger group (local Redpanda)',
  () => {
    const prefix = `gate-${Math.random().toString(36).slice(2, 8)}.`;
    const kafka = createKafka({ clientId: 'accounting-month-replay' });
    // the repo's topic policy: the relay refuses to start unless every event topic of it exists under the prefix
    const policy = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../infra/redpanda/topics.policy.json', import.meta.url)),
        'utf8',
      ),
    ) as TopicPolicy;
    const coreDir = fileURLToPath(new URL('../../core', import.meta.url));
    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
    const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };
    const consumers: EventConsumer[] = [];
    let live: AccountingTestDatabase; // the live run's ledger (and the outbox the month is written to)
    let fresh: AccountingTestDatabase; // the replayed ledger
    let events: EventEnvelopeV1Base[];
    const timings: Record<string, number> = {};
    const entities = [
      { le: LE_A, code: 'le_brand_a', currency: 'EUR' },
      { le: LE_B, code: 'le_brand_b', currency: 'GBP' },
      { le: LE_C, code: 'le_brand_c', currency: 'USD' },
    ];

    const count = async (db: AccountingTestDatabase, sql: string, params: unknown[] = []) =>
      Number(
        (await db.hq.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params))
          .rows[0]!.n,
      );
    const until = async (cond: () => boolean, what: string, ms: number) => {
      const t0 = Date.now();
      while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    const timed = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
      const t0 = Date.now();
      const out = await fn();
      timings[`${key}_ms`] = Date.now() - t0;
      return out;
    };
    const consumerFor = (db: AccountingTestDatabase, group: string) => {
      const c = createLedgerConsumer({
        client: db.hq,
        kafka,
        topicPrefix: prefix,
        groupId: `${prefix}${group}`,
        fromBeginning: true,
        log: quiet,
      });
      consumers.push(c);
      return c;
    };
    /** Spawns one of apps/core's outbox CLIs against the LIVE throwaway database; its last stdout line is the summary. */
    const runCoreCli = (script: string, args: string[]) => {
      const url = new URL(process.env.DATABASE_URL_APP!);
      url.pathname = `/${live.db.name}`;
      return new Promise<Record<string, unknown>>((done, fail) => {
        execFile(
          process.execPath,
          [tsxCli, `src/outbox/${script}`, ...args, '--no-registry', '--topic-prefix', prefix],
          {
            cwd: coreDir,
            env: {
              ...process.env,
              DATABASE_URL_APP: url.toString(),
              CORE_ORGANIZATION_ID: SEED_IDS.organization,
            },
            timeout: 120_000,
            maxBuffer: 16 * 1024 * 1024,
          },
          (err, stdout, stderr) => {
            if (err)
              return fail(
                new Error(`${script} ${args.join(' ')} failed: ${String(stderr).slice(-2000)}`),
              );
            const last = String(stdout).trim().split('\n').at(-1) ?? '{}';
            done(JSON.parse(last) as Record<string, unknown>);
          },
        );
      });
    };
    /** `outbox:relay --once` over every unpublished row (one pass, batch ≥ the month). */
    const relay = () =>
      runCoreCli('relay-cli.ts', [
        '--once',
        '--throwaway-db',
        '--batch',
        String(events.length + 1),
      ]);
    /** `outbox:replay --topic <t>` per topic: `first` in parallel, then `last` (the orders), each in seq order. */
    const replay = async (first: string[], last: string[]) => {
      const run = (topic: string) => runCoreCli('replay-cli.ts', ['--topic', topic]);
      const out = await Promise.all(first.map(run));
      for (const t of last) out.push(await run(t));
      return out;
    };
    const expectReplayed = (summaries: Record<string, unknown>[], rows: { topic: string }[]) => {
      for (const sm of summaries) {
        const n = rows.filter((r) => r.topic === sm.topic).length;
        expect(sm, String(sm.topic)).toMatchObject({ replay: 'outbox', rows: n, published: n });
      }
      expect(summaries.map((x) => x.topic).sort()).toEqual([...LEDGER_TOPICS].sort());
    };
    const readOutbox = async (db: AccountingTestDatabase) => {
      const r = await db.hq.query<{ id: string; topic: string; published: boolean }>(
        `SELECT id, topic, published_at IS NOT NULL AS published
           FROM outbox o WHERE topic = ANY($1::text[]) ORDER BY o.seq`,
        [[...LEDGER_TOPICS]],
      );
      return r.rows;
    };
    const perAccount = async (db: AccountingTestDatabase) => {
      const r = await db.hq.query<{ k: string; diff: string }>(
        `SELECT legal_entity_id || '|' || currency || '|' || account_code AS k, (sum(debit_minor) - sum(credit_minor))::text AS diff
           FROM ledger_entry GROUP BY 1 ORDER BY 1`,
      );
      return Object.fromEntries(r.rows.map((x) => [x.k, Number(x.diff)]));
    };

    beforeAll(async () => {
      live = await createAccountingTestDatabase();
      fresh = await createAccountingTestDatabase();
      const month = generateMonth({
        orders: ORDERS,
        seed: 4040,
        deterministicIds: true,
        nullFeeRate: 0,
        legalEntities: 3,
        ordersPerDay: Math.max(1, Math.floor(ORDERS / 27)),
      });
      events = month.events;
      // the month enters through the outbox table, as the core's withEvents would write it
      await live.hq.transaction(async (tx) => {
        for (const e of events) {
          const r = toOutboxRow(e as EventEnvelope);
          await tx.query(
            `INSERT INTO outbox (id, organization_id, store_id, topic, version, aggregate_type, aggregate_id, payload, headers, occurred_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              r.id,
              r.organization_id,
              r.store_id,
              r.topic,
              r.version,
              r.aggregate_type,
              r.aggregate_id,
              r.payload,
              r.headers,
              r.occurred_at,
            ],
          );
        }
      });
      const admin = kafka.admin();
      await admin.connect();
      await ensureTopics(
        admin,
        planTopics(policy, { environment: 'ci', prefix }).filter((t) => t.kind === 'event'),
      );
      await admin.disconnect();
      console.info(
        JSON.stringify({
          test: 'month-replay',
          orders: ORDERS,
          events: events.length,
          shipments: month.shipments,
          captures: month.captures,
          refunds: month.refunds,
          cancellations: month.cancellations,
          prefix,
        }),
      );
    }, 300_000);

    afterAll(async () => {
      // #589 nit: a broker failure here (deleteTopics timing out) must not leave the two throwaway databases behind
      try {
        for (const c of consumers) await c.stop().catch(() => {});
        const admin = kafka.admin();
        await admin.connect();
        try {
          const mine = (await admin.listTopics()).filter((t) => t.startsWith(prefix));
          if (mine.length) await admin.deleteTopics({ topics: mine, timeout: 30_000 });
          const groups = (await admin.listGroups()).groups
            .map((g) => g.groupId)
            .filter((g) => g.startsWith(prefix));
          if (groups.length) await admin.deleteGroups(groups).catch(() => {});
        } finally {
          await admin.disconnect();
        }
      } finally {
        await live?.drop();
        await fresh?.drop();
        console.info(JSON.stringify({ test: 'month-replay', ...timings }));
      }
    }, 120_000);

    it('the live run: relayed in seq order, every event handled once, books balanced per legal entity per currency', async () => {
      const rows = await readOutbox(live);
      expect(rows.length).toBe(events.length);
      const consumer = consumerFor(live, LEDGER_GROUP);
      await consumer.start();
      const relayed = await timed('relay', relay);
      expect(relayed).toMatchObject({ relay: 'outbox', published: rows.length, failed: 0 });
      // the relay marked every row it published (in the throwaway database only)
      expect((await readOutbox(live)).every((r) => r.published)).toBe(true);
      await timed('consume', () =>
        until(
          () => consumer.stats.handled >= rows.length,
          `${rows.length} events handled`,
          CEILING_MS.consume,
        ),
      );
      expect(consumer.stats).toMatchObject({
        handled: rows.length,
        dead_lettered: 0,
        skipped_unknown: 0,
      });
      expect(await count(live, 'accounting_parked_event')).toBe(0);
      for (const e of entities) {
        const balance = await live.hq.transaction((tx) => balanceByCurrency(tx, e.le));
        expect(Object.keys(balance), e.code).toEqual([e.currency]);
        expect(balance[e.currency], `${e.code} ${e.currency}`).toBe(0);
      }
      expect(timings.relay_ms).toBeLessThan(CEILING_MS.relay);
    }, 400_000);

    it('(1) replayed — all topics at once, orders last — into a fresh group and database: zero trial balance, identical to the live ledger', async () => {
      const rows = await readOutbox(live);
      const consumer = consumerFor(fresh, `${LEDGER_GROUP}.replay`);
      await consumer.start();
      const replayed = await timed('replay', () =>
        replay(
          ['shipment.shipped', 'refund.issued', 'order.cancelled', 'payment.captured'],
          ['order.placed'],
        ),
      );
      expectReplayed(replayed, rows);
      await timed('replay_consume', () =>
        until(
          () => consumer.stats.handled >= rows.length,
          `${rows.length} replayed events handled`,
          CEILING_MS.replay_consume,
        ),
      );
      expect(consumer.stats).toMatchObject({ handled: rows.length, dead_lettered: 0 });
      expect(await count(fresh, 'accounting_parked_event')).toBe(0);
      const totals: Record<string, unknown>[] = [];
      for (const e of entities) {
        const balance = await fresh.hq.transaction((tx) => balanceByCurrency(tx, e.le));
        expect(balance, e.code).toEqual({ [e.currency]: 0 });
        const tb = await fresh.hq.transaction((tx) => trialBalance(tx, e.le));
        totals.push({
          legal_entity: e.code,
          currency: e.currency,
          accounts: tb.length,
          debit_minor: tb.reduce((a, r) => a + r.debit_minor, 0),
          credit_minor: tb.reduce((a, r) => a + r.credit_minor, 0),
        });
      }
      expect(await perAccount(fresh)).toEqual(await perAccount(live));
      // not the row count: a cancel the live run consumed before an earlier shipment posts a corrective entry (more
      // rows, same totals) — the per-account totals above are the ledger, and they are identical
      console.info(JSON.stringify({ test: 'month-replay', gate: 'trial balance', totals }));
      expect(timings.replay_ms).toBeLessThan(CEILING_MS.replay);
    }, 400_000);

    it("(2) the month's payout reports reconcile with zero differences; the PSP clearing account equals the open balance", async () => {
      const reports = entities.map((e) => payoutReportFor(events, e.le, e.code, e.currency));
      const deps = { client: fresh.hq, source: createFixtureSource(reports), log: quiet };
      const summary: Record<string, unknown>[] = [];
      await timed('reconcile', async () => {
        for (const e of entities) {
          const results = await reconcileAll(deps, e.le);
          const report = reports.find((r) => r.legal_entity_id === e.le)!;
          expect(results.length, e.code).toBe(report.payouts.length);
          expect(
            results.every(
              (r) => r.status === 'reconciled' && r.discrepancies.length === 0 && r.posted,
            ),
            e.code,
          ).toBe(true);
          const clearing = await fresh.hq.transaction((tx) => pspClearingBalance(tx, e.le));
          const paid = report.payouts.reduce((a, p) => a + p.amount_minor, 0);
          const captured = await fresh.hq.query<{ net: string }>(
            'SELECT (coalesce(sum(amount_minor - fee_minor), 0))::text AS net FROM accounting_payment WHERE legal_entity_id = $1',
            [e.le],
          );
          const refunded = await fresh.hq.query<{ amount: string }>(
            'SELECT coalesce(sum(amount_minor), 0)::text AS amount FROM accounting_refund WHERE legal_entity_id = $1',
            [e.le],
          );
          const open = Number(captured.rows[0]!.net) - Number(refunded.rows[0]!.amount) - paid;
          expect(clearing, e.code).toEqual({ [e.currency]: open });
          summary.push({
            legal_entity: e.code,
            currency: e.currency,
            payouts: results.length,
            lines: results.reduce((a, r) => a + r.lines, 0),
            paid_out_minor: paid,
            open_minor: open,
            discrepancies: 0,
          });
        }
      });
      for (const e of entities)
        expect((await fresh.hq.transaction((tx) => balanceByCurrency(tx, e.le)))[e.currency]).toBe(
          0,
        );
      console.info(
        JSON.stringify({ test: 'month-replay', gate: 'payout reconciliation', summary }),
      );
      expect(timings.reconcile_ms).toBeLessThan(CEILING_MS.reconcile);
    }, 300_000);

    it('(3) a second replay into the same group changes nothing', async () => {
      const rows = await readOutbox(live);
      const consumer = consumers[consumers.length - 1]!; // the fresh group's consumer, still running
      const before = {
        entries: await count(fresh, 'ledger_entry'),
        processed: await count(fresh, PROCESSED_TABLE),
        payouts: await count(fresh, 'psp_payout'),
        handled: consumer.stats.handled,
        duplicates: consumer.stats.duplicates,
      };
      expectReplayed(await replay([...LEDGER_TOPICS], []), rows);
      await until(
        () => consumer.stats.duplicates >= before.duplicates + rows.length,
        `${rows.length} duplicates`,
        CEILING_MS.replay_consume,
      );
      expect(consumer.stats.handled).toBe(before.handled);
      expect(consumer.stats.dead_lettered).toBe(0);
      expect(await count(fresh, 'ledger_entry')).toBe(before.entries);
      expect(await count(fresh, PROCESSED_TABLE)).toBe(before.processed);
      expect(await count(fresh, 'psp_payout')).toBe(before.payouts);
      expect(await count(fresh, 'accounting_parked_event')).toBe(0);
      for (const e of entities)
        expect((await fresh.hq.transaction((tx) => balanceByCurrency(tx, e.le)))[e.currency]).toBe(
          0,
        );
    }, 300_000);
  },
);

// Local runs 2026-10-23, final code (150 orders = 556 events; relay / consume / replay / replay_consume / reconcile, ms):
//   run 1: 1,009 / 14,828 / 212 / 12,015 / 364 · run 2: 605 / 12,412 / 211 / 13,206 / 355 · run 3: 1,161 / 16,830 / 199 / 19,212 / 608
//   medians 1,009 / 14,828 / 211 / 13,206 / 364 → ceilings 30 s / 120 s / 30 s / 120 s / 30 s (≥ 5×).
// 2026-10-25 (#594): relay and replay are spawned CLIs now (tsx start-up of apps/core per process): their ceilings
// are 60 s each, unmeasured locally; the three required CI runs on the switch PR are the first measurements.
