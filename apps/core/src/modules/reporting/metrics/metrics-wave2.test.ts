// BI v2 wave 2 (#935), the pure parts: the new filters and their errors, the JSON / CSV row limits, the utm PII
// shapes, the small-cell rule with its complementary cell, the promotions SQL (Postgres: no code ever selected, the
// scope always bound), and the catalogue's own rules for the new metrics. The SQL itself runs on ClickHouse in
// metrics-wave2-live.test.ts.
import { describe, expect, it } from 'vitest';
import type { AppError } from '../../../lib/errors';
import { isAdditive, METRIC_IDS, METRICS, type MetricId } from './catalogue';
import { compileMetricQuery } from './compile';
import {
  executeMetricQuery,
  suppressSmallCells,
  utmValue,
  type MetricRow,
  type MetricsReader,
} from './execute';
import { moversFromResult, parseMoversQuery } from './movers';
import { getCustomerCohorts, parseCohortQuery } from './operations';
import { promotionsSql } from './promotions';
import { parseMetricQuery } from './query';

const A = '00000000-0000-4000-8000-000000000031';
const base = { from: '2026-10-01', to: '2026-11-01', grain: 'total' };
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return { code: (e as AppError).code, details: (e as AppError).details };
  }
  return null;
};
const WAVE2 = METRIC_IDS.slice(METRIC_IDS.indexOf('customers')) as MetricId[];

describe('catalogue v3 (#935)', () => {
  it('every new metric has a source or a derivation; distributions and distinct counts are not additive', () => {
    for (const m of WAVE2)
      expect(Boolean(METRICS[m].source) !== Boolean(METRICS[m].derived), m).toBe(true);
    for (const m of WAVE2.filter((x) => METRICS[x].kind === 'distribution')) {
      expect(METRICS[m]).toMatchObject({ unit: 'hours', total: 'query', currency_bound: false });
      expect(isAdditive(METRICS[m]), m).toBe(false);
    }
    expect(isAdditive(METRICS.customers)).toBe(false);
    expect(isAdditive(METRICS.attributed_orders)).toBe(true);
  });

  it('per-customer metrics always fetch the customer count (the small-cell rule needs it)', () => {
    const c = compileMetricQuery(
      parseMetricQuery({ ...base, metrics: ['customer_net_sales_minor'] }),
      [A],
    );
    expect(c.sources[0]!.metrics).toEqual(['customer_net_sales_minor', 'customers']);
    // the key is aggregated inside ClickHouse: the outer query never selects it
    expect(c.sources[0]!.sql).toMatch(
      /^SELECT any\(out_period\) AS out_p, out_currency, countIf\(k IS NOT NULL\)|^SELECT any\(out_period\)/,
    );
    expect(c.sources[0]!.sql.split('FROM (')[0]).not.toContain('customer_key');
  });
});

describe('the new filters', () => {
  it('touch: first or last, attribution metrics only; the compiled query binds it (last by default)', () => {
    expect(
      code(() => parseMetricQuery({ ...base, metrics: ['orders'], filters: { touch: 'last' } })),
    ).toMatchObject({
      code: 'validation_error',
      details: { field: 'filters.touch' },
    });
    expect(
      code(() =>
        parseMetricQuery({ ...base, metrics: ['attributed_orders'], filters: { touch: 'middle' } }),
      ),
    ).toMatchObject({ details: { field: 'filters.touch' } });
    const dflt = compileMetricQuery(parseMetricQuery({ ...base, metrics: ['attributed_orders'] }), [
      A,
    ]);
    expect(dflt.sources[0]!.params.touch).toBe('last');
    const first = compileMetricQuery(
      parseMetricQuery({ ...base, metrics: ['attributed_orders'], filters: { touch: 'first' } }),
      [A],
    );
    expect(first.sources[0]!.params.touch).toBe('first');
  });

  it('utm values must be what the models store (lower-case, trimmed); a filter the metric cannot narrow is a 400', () => {
    expect(
      code(() =>
        parseMetricQuery({
          ...base,
          metrics: ['attributed_orders'],
          filters: { utm_sources: ['Google'] },
        }),
      ),
    ).toMatchObject({ details: { field: 'filters.utm_sources' } });
    expect(
      code(() =>
        compileMetricQuery(
          parseMetricQuery({ ...base, metrics: ['orders'], filters: { campaign_ids: [A] } }),
          [A],
        ),
      ),
    ).toMatchObject({ details: { field: 'filters.campaign_ids' } });
    // the promotions source (Postgres) is checked the same way
    expect(
      code(() =>
        compileMetricQuery(
          parseMetricQuery({
            ...base,
            metrics: ['promotion_orders'],
            filters: { carriers: ['dhl'] },
          }),
          [A],
        ),
      ),
    ).toMatchObject({ details: { field: 'filters.carriers' } });
  });

  it('JSON answers at most 1 000 rows; text/csv up to 10 000', () => {
    expect(
      code(() => parseMetricQuery({ ...base, metrics: ['orders'], limit: 5000 })),
    ).toMatchObject({
      details: { field: 'limit' },
    });
    expect(
      parseMetricQuery({ ...base, metrics: ['orders'], limit: 10_000 }, { csv: true }).limit,
    ).toBe(10_000);
    expect(
      code(() => parseMetricQuery({ ...base, metrics: ['orders'], limit: 10_001 }, { csv: true })),
    ).not.toBeNull();
  });
});

describe('utm values (decision 5)', () => {
  it.each([
    ['google', 'google'],
    ['spring_sale_2026', 'spring_sale_2026'],
    ['someone@example.test', 'other'],
    ['someone%40example.test', 'other'],
    ['+31 6 1234 5678', 'other'],
    ['order-1234567', 'other'],
    ['k8f9a7d6s5f4g3h2j1k0l9m8n7', 'other'],
  ])('%s → %s', (v, out) => expect(utmValue(v)).toBe(out));
});

describe('small cells (#935 c, the #951 review rule)', () => {
  const row = (period: string): MetricRow =>
    ({
      period,
      currency: 'EUR',
      suppressed: false,
      values: { customer_net_sales_minor: 100, customers: 1 },
    }) as never;
  const run = (customers: number[], periods: string[], partitioned = true) => {
    const rows = periods.map(row);
    const unsafe = suppressSmallCells(
      rows,
      customers.map((c) => ({ customers: c })),
      partitioned,
    );
    return { hidden: rows.map((r) => r.suppressed), unsafe };
  };

  it('a hidden row loses EVERY value; complements are added until the hidden rows cover 5 customers', () => {
    // two 1-customer rows cover 2: the smallest visible row (3) joins, still 5 short of nothing → 1 + 1 + 3 = 5
    expect(run([1, 1, 9, 3], ['p', 'p', 'p', 'p']).hidden).toEqual([true, true, false, true]);
    const rows = [row('p'), row('p')];
    suppressSmallCells(rows, [{ customers: 2 }, { customers: 8 }], true);
    expect(rows[0]!.values).toEqual({ customer_net_sales_minor: null, customers: null });
  });

  it('a group that cannot reach 5 customers is hidden whole and its currency total is unsafe', () => {
    const r = run([1, 2, 1], ['p', 'p', 'p']);
    expect(r.hidden).toEqual([true, true, true]);
    expect([...r.unsafe]).toEqual(['EUR']);
    expect([...run([7, 6], ['p', 'p']).unsafe]).toEqual([]);
  });

  it('rows that can share customers (customer type, country) count only their largest row', () => {
    // 3 + 3 might be the same 3 people: not enough, the 9 joins
    expect(run([3, 3, 9], ['p', 'p', 'p'], false).hidden).toEqual([true, true, true]);
    expect(run([3, 3, 9], ['p', 'p', 'p'], true).hidden).toEqual([true, true, false]);
  });

  // The rule, not the examples: over random answers grouped by customer group, NO signed sum of the figures an answer
  // shows (rows and totals, every money metric) equals the money of any set of hidden rows resting on < 5 customers.
  // Money is drawn large and random, so a hit is a derivation, never a coincidence. (The 0.4.31 code fails this:
  // two 1-customer rows hidden with no complement were given back by total − visible.)
  it('property: no sum or difference of visible figures reveals a value resting on fewer than 5 customers', async () => {
    let random = 935;
    const rnd = () => (random = (random * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    let checked = 0;
    for (let seed = 0; seed < 150; seed++) {
      const periods = rnd() < 0.5 ? ['2026-10-01'] : ['2026-10-01', '2026-10-02'];
      const fixture = periods.flatMap((period) =>
        Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, g) => ({
          period,
          group: `00000000-0000-4000-8000-0000000000${String(10 + g)}`,
          customers: 1 + Math.floor(rnd() * 9),
          net: 1_000_000 + Math.floor(rnd() * 1_000_000_000),
        })),
      );
      const reader: MetricsReader = {
        async query({ query }) {
          const sales = !query.includes('fct_order_sales'); // net_sales_minor: fct_order_line
          const grouped = query.includes('out_cgroup');
          const rows = query.includes('FROM raw_events')
            ? [{ t: null }]
            : grouped
              ? fixture.map((f) => ({
                  out_period: periods.length > 1 ? f.period : null,
                  out_currency: 'EUR',
                  out_cgroup: f.group,
                  ...(sales
                    ? { m_net_sales_minor: String(f.net) }
                    : {
                        m_customers: String(f.customers),
                        m_customer_net_sales_minor: String(f.net),
                      }),
                }))
              : [
                  {
                    out_currency: 'EUR',
                    m_customers: String(fixture.reduce((n, f) => n + f.customers, 0)),
                  },
                ];
          return { json: async <T>() => rows as T[] };
        },
      };
      for (const metrics of [
        ['customers', 'customer_net_sales_minor', 'revenue_per_customer_minor'],
        ['net_sales_minor'],
      ]) {
        const r = await executeMetricQuery(
          reader,
          parseMetricQuery({
            ...base,
            grain: periods.length > 1 ? 'day' : 'total',
            metrics,
            dimensions: ['customer_group'],
          }),
          [A],
        );
        const money = ['customer_net_sales_minor', 'net_sales_minor', 'revenue_per_customer_minor'];
        // per money metric (figures of different metrics do not add up to anything): every signed combination
        // (−1, 0, +1) of the figures the answer shows — its rows and its totals
        const sumsOf = (m: string) => {
          const visible = [
            ...r.rows.map((x) => x.values[m]),
            ...r.currency_totals.map((t) => t.values[m]),
          ].filter((x): x is number => typeof x === 'number');
          let sums = new Set<number>([0]);
          for (const f of visible) {
            const next = new Set<number>();
            for (const x of sums) for (const y of [x, x + f, x - f]) next.add(y);
            sums = next;
          }
          return sums;
        };
        const sums = money.filter((m) => metrics.includes(m)).map(sumsOf);
        // the secrets: every set of hidden rows (within a period) whose customers add up to fewer than 5
        const hidden = fixture.filter((f) =>
          r.rows.some(
            (x) =>
              x.suppressed &&
              x.customer_group_id === f.group &&
              (periods.length === 1 || x.period === f.period),
          ),
        );
        for (const period of periods) {
          const inPeriod = hidden.filter((f) => f.period === period);
          for (let mask = 1; mask < 1 << inPeriod.length; mask++) {
            const set = inPeriod.filter((_, i) => mask & (1 << i));
            if (set.reduce((n, f) => n + f.customers, 0) >= 5) continue;
            const secret = set.reduce((n, f) => n + f.net, 0);
            for (const ss of sums)
              expect(ss.has(secret), `seed ${seed}: ${JSON.stringify(set)}`).toBe(false);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('a missing campaign budget (#951 review 5)', () => {
  it('is null, never 0: a campaign with net sales and no planned budget in the range', async () => {
    const C = '00000000-0000-4000-8000-0000000c0001';
    const reader: MetricsReader = {
      async query({ query }) {
        const rows = query.includes('FROM raw_events')
          ? [{ t: null }]
          : query.includes('fct_order_touch')
            ? [{ out_campaign: C, out_currency: 'EUR', m_campaign_net_sales_minor: '9000' }]
            : [];
        return { json: async <T>() => rows as T[] };
      },
    };
    const r = await executeMetricQuery(
      reader,
      parseMetricQuery({
        ...base,
        metrics: ['campaign_net_sales_minor', 'campaign_budget_minor'],
        dimensions: ['campaign'],
      }),
      [A],
    );
    expect(r.rows[0]!.values).toEqual({
      campaign_net_sales_minor: 9000,
      campaign_budget_minor: null,
    });
    expect(r.currency_totals[0]!.values.campaign_budget_minor).toBeNull();
  });
});

describe('promotions from Postgres (R1)', () => {
  it('reads the frozen allocation, never a code; scope and dates are parameters; filters bind as parameters', () => {
    const q = parseMetricQuery({
      ...base,
      grain: 'month',
      metrics: ['promotion_orders', 'promotion_discount_minor'],
      dimensions: ['promotion'],
      filters: { promotion_ids: [A], currencies: ['EUR'] },
    });
    const { sql, params } = promotionsSql(
      q,
      [A],
      ['promotion_orders', 'promotion_discount_minor'],
      true,
    );
    expect(sql).toContain("o.metadata->'promotions'");
    expect(sql).not.toMatch(/\bcode\b/);
    expect(sql).toContain('o.store_id = ANY($1::uuid[])');
    expect(sql).toContain("o.status <> 'cancelled'");
    expect(params).toEqual([[A], '2026-10-01', '2026-11-01', [A], ['EUR']]);
  });
});

describe('movers by customer type, customer group and warehouse (#935 a2)', () => {
  it.each([
    ['net_sales_minor', 'customer_group', 'customer_group_id'],
    ['units', 'customer_type', 'customer_type'],
    ['orders_shipped', 'warehouse', 'warehouse_id'],
  ] as const)('%s by %s ranks the %s column', async (metric, dimension, column) => {
    const mq = parseMoversQuery({ metric, dimension, from: '2026-10-01', to: '2026-11-01' });
    const row = (key: string, v: number) => ({
      [column]: key,
      currency: null,
      values: { [metric]: v },
    });
    const r = moversFromResult(
      mq,
      {
        rows: [row('x', 10), row('y', 50)],
        currency_totals: [],
        data_as_of: null,
        compare: {
          rows: [row('x', 40), row('y', 20)],
          currency_totals: [],
          current_incomplete: false,
        },
      } as never,
      new Date('2026-11-19T00:00:00Z'),
    );
    expect(r.by_currency[0]!.risers.map((m) => m.key)).toEqual(['y']);
    expect(r.by_currency[0]!.fallers.map((m) => m.key)).toEqual(['x']);
  });
});

describe('cohort LTV after a hidden cell (#951 review 3)', () => {
  // LTV to date is cumulative: a visible LTV at or after a hidden cell would give the hidden cell's net back from
  // two neighbours. Over random cohorts: no LTV is shown from the first hidden cell on, and the cells before it show.
  it('property: from the first hidden cell on, no LTV is shown', async () => {
    let random = 951;
    const rnd = () => (random = (random * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    let hiddenSeen = 0;
    for (let seed = 0; seed < 200; seed++) {
      const size = 3 + Math.floor(rnd() * 20);
      const months = 2 + Math.floor(rnd() * 6);
      const cells = Array.from({ length: months }, (_, k) => ({
        out_cohort: '2026-01-01',
        out_offset: k,
        m_active: String(k === 0 ? size : Math.floor(rnd() * (size + 1))),
        m_net: String(1_000_000 + Math.floor(rnd() * 1_000_000_000)),
      }));
      const reader: MetricsReader = {
        async query({ query }) {
          const rows = query.includes('m_size')
            ? [{ out_cohort: '2026-01-01', m_size: String(size) }]
            : cells;
          return { json: async <T>() => rows as T[] };
        },
      };
      const r = await getCustomerCohorts(
        reader,
        parseCohortQuery({ from_month: '2026-01', to_month: '2026-01', months, currency: 'EUR' }),
        [A],
        new Date('2026-12-31T00:00:00Z'),
      );
      const out = r.cohorts[0]!.cells;
      const first = out.findIndex((c) => c.suppressed);
      if (first >= 0) hiddenSeen++;
      out.forEach((c, k) => {
        if (first >= 0 && k >= first)
          expect(c.ltv_to_date_minor, `seed ${seed} cell ${k}`).toBeNull();
        else expect(c.ltv_to_date_minor, `seed ${seed} cell ${k}`).not.toBeNull();
        if (c.suppressed)
          expect(
            (Number(cells[k]!.m_active) > 0 && Number(cells[k]!.m_active) < 5) || size < 5,
          ).toBe(true);
      });
    }
    expect(hiddenSeen).toBeGreaterThan(20);
  });
});

describe('movers never turn a hidden value into 0 (#951 re-review)', () => {
  it('a key hidden in either range is no mover; a hidden total stays null, and so do the shares', () => {
    const mq = parseMoversQuery({
      metric: 'customer_net_sales_minor',
      dimension: 'customer_group',
      from: '2026-10-01',
      to: '2026-11-01',
    });
    const row = (key: string, v: number | null, suppressed = false) => ({
      customer_group_id: key,
      currency: 'EUR',
      suppressed,
      values: { customer_net_sales_minor: v },
    });
    const r = moversFromResult(
      mq,
      {
        rows: [row('hidden', null, true), row('y', 9000), row('z', 100)],
        currency_totals: [
          { currency: 'EUR', values: { customer_net_sales_minor: null }, suppressed: true },
        ],
        data_as_of: null,
        compare: {
          rows: [row('hidden', 5000), row('y', 1000), row('z', 400)],
          currency_totals: [{ currency: 'EUR', values: { customer_net_sales_minor: 6400 } }],
          current_incomplete: false,
        },
      } as never,
      new Date('2026-11-25T00:00:00Z'),
    );
    const block = r.by_currency[0]!;
    expect([...block.risers, ...block.fallers].map((m) => m.key).sort()).toEqual(['y', 'z']);
    expect(block.total_current).toBeNull();
    expect([...block.risers, ...block.fallers].every((m) => m.share_bp === null)).toBe(true);
  });
});
