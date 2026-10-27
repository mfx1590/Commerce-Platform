// #603 without any service: the validator, the compiler (a property test over random valid queries: the scope is in
// every statement and no request value ever appears in SQL text) and the executor over a fake reader (merging,
// ratios, per-currency totals, ordering, truncation, fail-closed 503).
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../lib/errors';
import {
  DIMENSIONS,
  GRAINS,
  METRIC_IDS,
  METRICS,
  type Dimension,
  type MetricId,
} from './catalogue';
import { compileMetricQuery } from './compile';
import { executeMetricQuery, scopedEverywhere, type MetricsReader } from './execute';
import { parseMetricQuery, type MetricQuery } from './query';

const A = '00000000-0000-4000-8000-000000000031';
const B = '00000000-0000-4000-8000-000000000032';
const base = { metrics: ['bookings_minor'], grain: 'day', from: '2026-10-01', to: '2026-11-01' };

function code(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? { code: e.code, details: e.details } : e;
  }
  return 'no error';
}

describe('parseMetricQuery', () => {
  it('normalises a valid query (limit defaults to 1000, no filters)', () => {
    expect(parseMetricQuery(base)).toEqual({ ...base, dimensions: [], filters: {}, limit: 1000 });
  });

  it.each([
    [{ ...base, metrics: [] }, 'metrics'],
    [{ ...base, metrics: ['revenue_from_sql'] }, 'metrics'],
    [{ ...base, metrics: ['orders', 'orders'] }, 'metrics'],
    [
      {
        ...base,
        metrics: ['orders', 'units', 'refunds_minor', 'fee_minor', 'captured_minor', 'aov_minor'],
      },
      'metrics',
    ],
    [{ ...base, grain: 'hour' }, 'grain'],
    [{ ...base, from: '2026-02-30' }, 'from'],
    [{ ...base, to: '2026-10-01' }, 'to'],
    [{ ...base, to: '2027-10-03' }, 'to'],
    [{ ...base, sql: 'SELECT 1' }, 'sql'],
    [{ ...base, filters: { store_ids: ["x' OR 1=1"] } }, 'filters.store_ids'],
    [{ ...base, filters: { where: 'store_id = 1' } }, 'filters.where'],
    [{ ...base, order_by: { metric: 'orders' } }, 'order_by.metric'],
    [{ ...base, limit: 1001 }, 'limit'],
  ])('refuses %j (%s)', (body, field) => {
    const e = code(() => parseMetricQuery(body));
    expect(e).toMatchObject({ code: 'validation_error' });
    expect(JSON.stringify((e as { details: unknown }).details)).toContain(field.split('.')[0]!);
  });

  it('refuses a dimension a metric does not accept, naming both', () => {
    expect(code(() => parseMetricQuery({ ...base, dimensions: ['product'] }))).toEqual({
      code: 'validation_error',
      details: { metric: 'bookings_minor', dimension: 'product' },
    });
  });

  it('refuses customer counts next to money (one answer, one key shape)', () => {
    expect(
      code(() => parseMetricQuery({ ...base, metrics: ['bookings_minor', 'new_customers'] })),
    ).toMatchObject({
      code: 'validation_error',
      details: { metric: 'new_customers' },
    });
  });
});

// ---- a property test over random valid queries ---------------------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random query the validator accepts (metrics sharing a dimension set; filters that apply). */
export function randomQuery(random: () => number, stores: readonly string[]): MetricQuery {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
  for (;;) {
    const metrics = [
      ...new Set(Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(METRIC_IDS))),
    ];
    const shared = DIMENSIONS.filter((d) =>
      metrics.every((m) => METRICS[m].dimensions.includes(d)),
    );
    const dimensions = shared.filter(() => random() < 0.5).slice(0, 2) as Dimension[];
    const body: Record<string, unknown> = {
      metrics,
      dimensions,
      grain: pick(GRAINS),
      from: '2026-10-01',
      to: pick(['2026-10-08', '2026-11-01', '2027-01-01']),
      filters: random() < 0.5 ? { store_ids: stores.filter(() => random() < 0.7) } : {},
      ...(random() < 0.4
        ? { order_by: { metric: pick(metrics), direction: pick(['asc', 'desc']) } }
        : {}),
      limit: 1 + Math.floor(random() * 1000),
    };
    if ((body.filters as { store_ids?: string[] }).store_ids?.length === 0) body.filters = {};
    try {
      const q = parseMetricQuery(body);
      compileMetricQuery(q, stores); // filters that do not apply are refused there: draw again
      return q;
    } catch {
      /* not a valid combination: draw again */
    }
  }
}

describe('compileMetricQuery', () => {
  it('every statement of 500 random valid queries carries the scope predicate, and no value is in the SQL text', () => {
    const random = rng(603);
    for (let i = 0; i < 500; i++) {
      const q = randomQuery(random, [A]);
      expect(scopedEverywhere(q, [A]), JSON.stringify(q)).toBe(true);
      for (const s of compileMetricQuery(q, [A]).sources) {
        expect(s.params.scope).toEqual([A]);
        for (const v of [A, B, q.from, q.to]) expect(s.sql, JSON.stringify(q)).not.toContain(v);
      }
    }
  });

  it('money queries put currency in every key; count-only ones do not', () => {
    const money = compileMetricQuery(
      parseMetricQuery({ ...base, metrics: ['bookings_minor', 'orders'] }),
      [A],
    );
    expect(money.currencyKey).toBe(true);
    expect(money.sources[0]!.sql).toContain('toString(currency) AS out_currency');
    const counts = compileMetricQuery(parseMetricQuery({ ...base, metrics: ['units'] }), [A]);
    expect(counts.currencyKey).toBe(false);
    expect(counts.sources[0]!.sql).not.toContain('out_currency');
  });

  it('derived metrics pull their inputs (aov reads bookings and orders from one statement)', () => {
    const c = compileMetricQuery(
      parseMetricQuery({ ...base, metrics: ['aov_minor', 'refund_rate_bp'] }),
      [A],
    );
    expect(c.sources.map((s) => [s.source, s.metrics.sort()])).toEqual([
      ['bookings', ['bookings_minor', 'orders']],
      ['refunds', ['refunds_minor']],
    ]);
  });

  it('a filter a source cannot apply is a 400, not a silent no-op', () => {
    const q = parseMetricQuery({ ...base, filters: { product_ids: [B] } });
    expect(code(() => compileMetricQuery(q, [A]))).toMatchObject({ code: 'validation_error' });
  });
});

// ---- the executor over a fake reader --------------------------------------------------------------------------

function fakeReader(
  bySource: Record<string, Record<string, unknown>[]>,
  opts: { fail?: boolean } = {},
) {
  const seen: { query: string; params: Record<string, unknown> | undefined }[] = [];
  const reader: MetricsReader = {
    async query({ query, query_params }) {
      if (opts.fail)
        throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'ConnectionError' });
      seen.push({ query, params: query_params });
      const src = Object.keys(bySource).find((k) => query.includes(`FROM ${k}`));
      const rows = query.includes('FROM raw_events')
        ? [{ t: '2026-10-27 08:59:52.000' }]
        : (bySource[src ?? ''] ?? []);
      return { json: async <T>() => rows as T[] };
    },
  };
  return { reader, seen };
}

describe('executeMetricQuery', () => {
  const q = (body: Record<string, unknown>) => parseMetricQuery({ ...base, ...body });

  it('merges sources by key, computes ratios per row and per currency total, never across currencies', async () => {
    const { reader } = fakeReader({
      mart_bookings_daily: [
        {
          out_period: '2026-10-01',
          out_store: A,
          out_currency: 'EUR',
          m_bookings_minor: '1000',
          m_orders: '3',
        },
        {
          out_period: '2026-10-01',
          out_store: A,
          out_currency: 'GBP',
          m_bookings_minor: '500',
          m_orders: '1',
        },
        {
          out_period: '2026-10-02',
          out_store: A,
          out_currency: 'EUR',
          m_bookings_minor: '0',
          m_orders: '0',
        },
      ],
      fct_refund: [
        { out_period: '2026-10-01', out_store: A, out_currency: 'EUR', m_refunds_minor: '100' },
      ],
    });
    const r = await executeMetricQuery(
      reader,
      q({ metrics: ['aov_minor', 'refund_rate_bp', 'bookings_minor'], dimensions: ['store'] }),
      [A],
      () => new Date('2026-10-27T09:00:00Z'),
    );
    expect(r.rows.map((x) => [x.period, x.currency, x.values])).toEqual([
      ['2026-10-01', 'EUR', { aov_minor: 333, refund_rate_bp: 1000, bookings_minor: 1000 }],
      ['2026-10-01', 'GBP', { aov_minor: 500, refund_rate_bp: 0, bookings_minor: 500 }],
      ['2026-10-02', 'EUR', { aov_minor: null, refund_rate_bp: null, bookings_minor: 0 }],
    ]);
    expect(r.currency_totals).toEqual([
      { currency: 'EUR', values: { aov_minor: 333, refund_rate_bp: 1000, bookings_minor: 1000 } },
      { currency: 'GBP', values: { aov_minor: 500, refund_rate_bp: 0, bookings_minor: 500 } },
    ]);
    expect(r.data_as_of).toBe('2026-10-27T08:59:52.000Z');
  });

  it('orders by a metric (nulls last), truncates at the limit, and totals still cover every row', async () => {
    const rows = [5, 9, 1, 7].map((n, i) => ({
      out_period: null,
      out_store: [A, B, A, B][i],
      out_product: `00000000-0000-4000-8000-00000000000${i}`,
      m_units: String(n),
    }));
    const { reader } = fakeReader({ fct_order_line: rows });
    const r = await executeMetricQuery(
      reader,
      q({
        metrics: ['units'],
        dimensions: ['product'],
        grain: 'total',
        order_by: { metric: 'units' },
        limit: 2,
      }),
      [A, B],
    );
    expect(r.rows.map((x) => x.values.units)).toEqual([9, 7]);
    expect(r.truncated).toBe(true);
    expect(r.currency_totals).toEqual([{ currency: null, values: { units: 22 } }]);
  });

  it('passes the scope as a parameter to every statement', async () => {
    const { reader, seen } = fakeReader({});
    await executeMetricQuery(reader, q({ metrics: ['orders', 'refunds_minor'] }), [A]);
    const statements = seen.filter((s) => !s.query.includes('raw_events'));
    expect(statements).toHaveLength(2);
    for (const s of statements) expect(s.params?.scope).toEqual([A]);
  });

  it('fails closed with a 503 when ClickHouse does not answer (nothing partial)', async () => {
    const { reader } = fakeReader({}, { fail: true });
    const err = await executeMetricQuery(reader, q({}), [A]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 503 });
  });

  it('every catalogue metric compiles and executes (no metric without a source or a derivation)', async () => {
    const { reader } = fakeReader({});
    for (const m of METRIC_IDS as readonly MetricId[]) {
      const r = await executeMetricQuery(reader, q({ metrics: [m] }), [A]);
      expect(r.rows, m).toEqual([]);
    }
  });
});
