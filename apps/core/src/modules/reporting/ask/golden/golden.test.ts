// The BI Q&A golden set (#606 acceptance: 30 questions, a fake model, recorded tool calls), two ways:
//   * unit (always): a fake analytics reader that answers every metric for the stores a statement is scoped to;
//   * live (ANALYTICS_LIVE=1 with the machine; CI=true): the generated month in a throwaway ClickHouse database, the
//     real compiler and executor — the figures in each answer are checked against what ClickHouse returned.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { METRIC_IDS } from '../../metrics/catalogue';
import type { MetricsReader } from '../../metrics/execute';
import { GOLDEN, type GoldenEnv } from './cases';
import type { GatewayFactory } from '../gateway';
import { catalogueFor } from './catalogue';
import { runRealCase, type RealOutcome } from './real-model';
import { runGoldenCase, type GoldenStores } from './run';

it('the golden set has 30 questions with distinct ids', () => {
  expect(GOLDEN).toHaveLength(30);
  expect(new Set(GOLDEN.map((c) => c.id)).size).toBe(30);
});

describe('golden set on the fake reader (CI)', () => {
  const stores: GoldenStores = {
    A: { id: '00000000-0000-4000-8000-000000000031', code: 'brand-a' },
    B: { id: '00000000-0000-4000-8000-000000000032', code: 'brand-b' },
  };
  const env: GoldenEnv = {
    A: stores.A.id,
    B: stores.B.id,
    product: '00000000-0000-4000-8000-000000000071',
  };
  const reader: MetricsReader = {
    async query({ query, query_params }) {
      if (query.includes('FROM raw_events')) return { json: async <T>() => [{ t: null }] as T[] };
      const scope = (query_params?.scope as string[]) ?? [];
      const rows = scope.map((s, i) => ({
        out_period: '2026-10-01',
        out_currency: 'EUR',
        out_store: s,
        out_product: env.product,
        out_reason: 'return',
        out_provider: 'stripe',
        ...Object.fromEntries(METRIC_IDS.map((m, j) => [`m_${m}`, 1_000 * (i + 1) + j])),
      }));
      return { json: async <T>() => rows as T[] };
    },
  };

  it('the checks are not vacuous: a made-up figure, a citation of nothing, an uncited stray figure', async () => {
    const one = GOLDEN.find((c) => c.id === 1)!;
    const made = await runGoldenCase(one, env, stores, reader, 'bookings_minor EUR 999999.99 [q1]');
    expect(made.problems).toEqual([
      '999999.99 [q1] is not in that result',
      '999999.99 is in no result',
    ]);
    const dangling = await runGoldenCase(one, env, stores, reader, 'bookings_minor EUR 1.00 [q7]');
    expect(dangling.problems).toEqual(['[q7] cites no result', '1.00 is in no result']);
    // a correct answer passes; the same answer plus one uncited figure from nowhere does not (#677 review)
    const good = await runGoldenCase(one, env, stores, reader);
    expect(good.problems).toEqual([]);
    const stray = await runGoldenCase(
      one,
      env,
      stores,
      reader,
      `${good.answer!.answer}; and 42.42 besides`,
    );
    expect(stray.problems).toEqual(['42.42 is in no result']);
  });

  it.each(GOLDEN.map((c) => [c.id, c.question, c] as const))('#%i %s', async (_id, _q, c) => {
    const { problems } = await runGoldenCase(c, env, stores, reader);
    expect(problems).toEqual([]);
  });
});

// ---- live: the generated month on ClickHouse ----------------------------------------------------------------------

const CH = {
  url: process.env.CLICKHOUSE_URL?.trim() || 'http://127.0.0.1:18123',
  username: process.env.CLICKHOUSE_USER?.trim() || 'default',
  password: process.env.CLICKHOUSE_PASSWORD ?? '',
};

async function skipReason(): Promise<string | null> {
  if (process.env.ANALYTICS_LIVE !== '1' && process.env.CI !== 'true')
    return 'not opted in (set ANALYTICS_LIVE=1 once you hold the machine)';
  try {
    const auth = Buffer.from(`${CH.username}:${CH.password}`).toString('base64');
    const res = await fetch(`${CH.url}/?query=SELECT%201`, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(1_500),
    });
    return res.ok ? null : `ClickHouse ${CH.url}: HTTP ${res.status} for user ${CH.username}`;
  } catch (err) {
    return `ClickHouse ${CH.url}: ${(err as { cause?: { code?: string } }).cause?.code ?? (err as Error).name}`;
  }
}

const skip = await skipReason();
if (skip) console.warn(`golden.test (live): ${skip} — the ClickHouse golden run is skipped`);

describe.runIf(skip === null)('golden set on the generated month (ClickHouse)', () => {
  const db = `analytics_test_${Math.random().toString(36).slice(2, 8)}`;
  let close: () => Promise<void> = async () => {};
  let reader: MetricsReader;
  let env: GoldenEnv;
  let stores: GoldenStores;

  beforeAll(async () => {
    const ingest = await import('@platform/analytics-ingest');
    const { generateMonth, ORG, STORE_A, STORE_B } = await import('@platform/test-utils');
    const { createValidator } = await import('@platform/events');
    const admin = ingest.createChClient({ ...CH, database: 'default' }, 'default');
    const ch = ingest.createChClient({ ...CH, database: db }, db);
    close = async () => {
      await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` }).catch(() => {});
      await Promise.allSettled([admin.close(), ch.close()]);
    };
    await ingest.migrate(admin, ch, db, ingest.readSqlFiles());
    const month = generateMonth({
      orders: 300,
      legalEntities: 3,
      deterministicIds: true,
      seed: 6060,
    });
    const validator = createValidator();
    const rows = [...catalogueFor(month.events, ORG), ...month.events].map((e, i) => {
      // the same wire message as metrics-live.test (message, batch, context)
      const c = ingest.classify(
        {
          key: null,
          value: JSON.stringify(e),
          headers: { outbox_id: e.event_id },
          offset: String(i),
          timestamp: String(Date.parse(e.occurred_at)),
        },
        { topic: e.topic, partition: 0 },
        { groupId: 'analytics.raw', validator, now: new Date('2026-11-01T00:00:00Z') },
      );
      if (c.kind !== 'row') throw new Error(`fixture ${e.topic} dead-lettered`);
      return c.row;
    });
    await ingest.createRawEventsSink(ch).insert(rows);
    reader = ch as unknown as MetricsReader;
    const productRows = await (
      await ch.query({
        query:
          'SELECT toString(product_id) AS p FROM fct_order_line WHERE store_id = {a:UUID} LIMIT 1',
        format: 'JSONEachRow',
        query_params: { a: STORE_A },
      })
    ).json<{ p: string }>();
    stores = { A: { id: STORE_A, code: 'brand-a' }, B: { id: STORE_B, code: 'brand-b' } };
    env = {
      A: STORE_A,
      B: STORE_B,
      product: productRows[0]?.p ?? '00000000-0000-4000-8000-000000000071',
    };
  }, 300_000);

  afterAll(async () => {
    await close();
  });

  // #7 of the 2026-11-02 runs: generateMonth publishes no products, so every line's product was NULL and "top 5
  // products" had one combined row to rank. The setup now publishes PRODUCTS_PER_STORE products per store with
  // skewed volumes (catalogueFor); the scripted #7 must rank five distinct products, highest first.
  it('#7 "Top 5 products by units?" ranks five distinct products, highest first (products are published)', async () => {
    const seven = GOLDEN.find((c) => c.id === 7)!;
    const { problems, answer } = await runGoldenCase(seven, env, stores, reader);
    expect(problems).toEqual([]);
    const rows = answer!.queries[0]!.result!.rows;
    const products = rows.map((r) => r.product_id);
    expect(products.every((p) => p !== null)).toBe(true);
    expect(new Set(products).size).toBe(5);
    const units = rows.map((r) => r.values.units ?? 0);
    expect(units).toEqual([...units].sort((a, b) => b - a));
    expect(units[0]!).toBeGreaterThan(units[4]!); // skewed: a real ranking, not a tie
  });

  it('all 30 questions: queries valid or refused as expected, every figure backed by its result, no other store', async () => {
    const failures: string[] = [];
    for (const c of GOLDEN) {
      const { problems } = await runGoldenCase(c, env, stores, reader);
      for (const p of problems) failures.push(`#${c.id} ${c.question}: ${p}`);
    }
    expect(failures).toEqual([]);
  });

  // The REAL model, once, on the generated month (dev data only): opt-in AI_REAL_MODEL=1, with the machine and the
  // AI_ANTHROPIC_API_KEY line in .env (never printed). Limits generous for the one run; cost from the audit records.
  it.runIf(process.env.AI_REAL_MODEL === '1')(
    'the real model: the same 30 questions, the scope and every figure held to the results',
    async () => {
      const ai = await import('@platform/ai');
      const anthropic = ai.createAnthropicTransport({ env: process.env });
      let calls = 0;
      const transport: typeof anthropic = {
        kind: anthropic.kind,
        complete: (req) => {
          calls += 1;
          return anthropic.complete(req);
        },
      } as typeof anthropic;
      const audit = ai.createMemoryAuditSink();
      const limiter = ai.createMemoryLimiter();
      const limits = { monthlyTokens: 5_000_000, perMinute: 1_000 };
      const gatewayFor: GatewayFactory = (scope) =>
        ai.createAiGateway({
          ...scope,
          purpose: 'analysis',
          transport,
          limiter,
          audit,
          env: { AI_ENABLED: '1' },
          limits,
          orgLimits: limits,
        });
      const outcomes: RealOutcome[] = [];
      // AI_REAL_MODEL_CASES=7 (or 7,17): a targeted run of those cases only, a couple of calls instead of ~55
      const only = process.env.AI_REAL_MODEL_CASES?.split(',').map((s) => Number(s.trim()));
      for (const c of GOLDEN.filter((g) => !only || only.includes(g.id))) {
        const before = calls;
        outcomes.push(await runRealCase(c, env, stores, reader, gatewayFor, () => calls - before));
      }
      const tokens = audit.records.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);
      const costMicroUsd = audit.records.reduce((n, r) => n + r.costMicroUsd, 0);
      const passed = outcomes.filter((o) => o.problems.length === 0).length;
      // the WHOLE answer (dev data only): the 2026-11-02 re-run cut it at 240 characters and lost #8's and #17's causes
      for (const o of outcomes)
        console.info(
          `[bi-qa real] #${o.id} ${o.problems.length === 0 ? 'PASS' : 'FAIL'} ran=${o.ran} refused=${o.refused}` +
            `${o.error ? ` error=${o.error}` : ''}${o.problems.length ? ` problems=${JSON.stringify(o.problems)}` : ''}` +
            ` queries=${JSON.stringify(o.queries ?? [])} answer=${JSON.stringify(o.answer ?? '')}`,
        );
      console.info(
        `[bi-qa real] SUMMARY ${JSON.stringify({ passed, of: outcomes.length, model_calls: calls, audit_rows: audit.records.length, tokens, cost_usd: costMicroUsd / 1e6, outcomes_by_kind: audit.records.reduce<Record<string, number>>((m, r) => ({ ...m, [r.outcome]: (m[r.outcome] ?? 0) + 1 }), {}) })}`,
      );
      expect(outcomes.filter((o) => o.problems.length > 0)).toEqual([]);
    },
    1_200_000,
  );
});
