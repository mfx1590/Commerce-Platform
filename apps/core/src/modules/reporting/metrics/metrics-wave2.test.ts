// BI v2 wave 2 (#935), the pure parts: the new filters and their errors, the JSON / CSV row limits, the utm PII
// shapes, the small-cell rule with its complementary cell, the promotions SQL (Postgres: no code ever selected, the
// scope always bound), and the catalogue's own rules for the new metrics. The SQL itself runs on ClickHouse in
// metrics-wave2-live.test.ts.
import { describe, expect, it } from 'vitest';
import type { AppError } from '../../../lib/errors';
import { isAdditive, METRIC_IDS, METRICS, type MetricId } from './catalogue';
import { compileMetricQuery } from './compile';
import { suppressSmallCells, utmValue, type MetricRow } from './execute';
import { moversFromResult, parseMoversQuery } from './movers';
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

describe('small cells (#935 c)', () => {
  const row = (period: string): MetricRow =>
    ({
      period,
      currency: 'EUR',
      suppressed: false,
      values: { revenue_per_customer_minor: 100 },
    }) as never;
  it('a row under 5 customers loses its per-customer values; one hidden cell takes the next-smallest with it', () => {
    const rows = [row('p'), row('p'), row('p'), row('q'), row('q')];
    suppressSmallCells(
      rows,
      [2, 9, 6, 7, 8].map((customers) => ({ customers })),
      ['revenue_per_customer_minor'],
    );
    expect(rows.map((r) => [r.suppressed, r.values.revenue_per_customer_minor])).toEqual([
      [true, null],
      [false, 100],
      [true, null], // the complementary cell: 6 is the next-smallest of period p
      [false, 100],
      [false, 100],
    ]);
  });
  it('two hidden cells need no complement; a metric that is not per customer is never touched', () => {
    const rows = [row('p'), row('p'), row('p')];
    suppressSmallCells(
      rows,
      [2, 3, 9].map((customers) => ({ customers })),
      ['revenue_per_customer_minor'],
    );
    expect(rows.map((r) => r.suppressed)).toEqual([true, true, false]);
    const counts = [row('p')];
    suppressSmallCells(counts, [{ customers: 1 }], ['customers']);
    expect(counts[0]!.suppressed).toBe(false);
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
