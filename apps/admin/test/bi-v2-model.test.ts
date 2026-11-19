/**
 * BI v2 wave 1 (#871): the pure model — URL state, filters, the catalogue's offer, value and change
 * formatting (JPY with no decimals, rates as points), comparison shaping — and the query bodies.
 */
import { describe, expect, it } from 'vitest';
import {
  breakdownOf,
  chunk,
  filtersOf,
  formatChange,
  formatValue,
  inventoryQuery,
  kpisOf,
  labelOf,
  offered,
  parseInventory,
  parseState,
  stateHref,
  type MetricResult,
} from '@/app/(hq)/bi/_v2/model';
import {
  breakdownQuery,
  moversQuery,
  overviewQueries,
  productsQuery,
} from '@/app/(hq)/bi/_v2/queries';
import { catalogue, CAT, PROD, STORE_A, STORE_B, totals } from './bi-v2-fixtures';

const NOW = new Date('2026-11-15T12:00:00Z');

describe('URL state', () => {
  it('defaults: last 30 UTC days, previous period, by store, no filter', () => {
    const state = parseState({}, NOW);
    expect(state).toMatchObject({
      compare: 'previous_period',
      by: 'store',
      store: '',
      currency: '',
    });
    expect(state.window.to > state.window.from).toBe(true);
  });

  it('malformed values fall back instead of reaching the API', () => {
    const state = parseState(
      {
        compare: 'last_decade',
        by: 'warehouse',
        store: 'brand-a',
        country: 'Japan',
        customer: 'vip',
        currency: 'yen',
      },
      NOW,
    );
    expect(state).toMatchObject({
      compare: 'previous_period',
      by: 'store',
      store: '',
      country: '',
      customer: '',
      currency: '',
    });
  });

  it('a link drops defaults and empties, and keeps the rest', () => {
    const state = parseState(
      { from: '2026-11-01', to: '2026-11-15', country: 'jp', store: STORE_A },
      NOW,
    );
    expect(state.country).toBe('JP');
    const href = stateHref('/bi/overview', state, { by: 'country' }, { rank: 'units' });
    const url = new URL(href, 'http://admin.test');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: '2026-11-01',
      to: '2026-11-15',
      by: 'country',
      store: STORE_A,
      country: 'JP',
      rank: 'units',
    });
    expect(stateHref('/bi/overview', state, { store: '', country: '', by: 'store' })).toBe(
      '/bi/overview?from=2026-11-01&to=2026-11-15',
    );
  });

  it('filters: every chosen one, and a store view is always narrowed to its store', () => {
    const state = parseState(
      { store: STORE_B, category: CAT, product: PROD, customer: 'new', country: 'JP' },
      NOW,
    );
    expect(filtersOf(state)).toEqual({
      store_ids: [STORE_B],
      countries: ['JP'],
      category_ids: [CAT],
      product_ids: [PROD],
      customer_types: ['new'],
    });
    expect(filtersOf(state, STORE_A).store_ids).toEqual([STORE_A]);
  });
});

describe('the catalogue decides what is asked', () => {
  it('a metric not offered (or not by that dimension) is left out and reported', () => {
    expect(offered(catalogue(), ['net_sales_minor', 'refunds_minor'], 'country')).toEqual({
      metrics: ['net_sales_minor'],
      missing: ['refunds_minor'],
    });
    const hidden = catalogue({
      metrics: catalogue().metrics.map((m) =>
        m.id === 'tax_minor' ? { ...m, available: false } : m,
      ),
    });
    expect(offered(hidden, ['tax_minor']).missing).toEqual(['tax_minor']);
  });

  it('the overview is split into queries of at most max_metrics, all with the same window and comparison', () => {
    const state = parseState({ from: '2026-11-01', to: '2026-11-15' }, NOW);
    const { queries, missing } = overviewQueries(catalogue(), state);
    expect(missing).toEqual([]);
    expect(queries.map((q) => q.metrics.length)).toEqual([6, 5]);
    for (const query of queries) {
      expect(query).toMatchObject({
        grain: 'total',
        from: '2026-11-01',
        to: '2026-11-15',
        compare: 'previous_period',
        dimensions: [],
      });
    }
    expect(chunk([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
  });

  it('no comparison: no compare in any body, and no movers query', () => {
    const state = parseState({ compare: 'none' }, NOW);
    expect(overviewQueries(catalogue(), state).queries.every((q) => !('compare' in q))).toBe(true);
    expect(moversQuery(state)).toBeNull();
    expect(moversQuery(parseState({ compare: 'previous_year', by: 'country' }, NOW))).toMatchObject(
      {
        metric: 'net_sales_minor',
        dimension: 'country',
        compare: 'previous_year',
      },
    );
  });

  it('breakdown by a dimension asks only the metrics offered by it', () => {
    const state = parseState({ by: 'category' }, NOW);
    expect(breakdownQuery(catalogue(), state)).toMatchObject({
      query: { metrics: ['net_sales_minor', 'orders', 'units'], dimensions: ['category'] },
      missing: ['aov_minor'],
    });
  });

  it('products: ranked by the chosen measure; a measure not offered by product gives no query', () => {
    const state = parseState({}, NOW);
    expect(productsQuery(catalogue(), state, 'units', 'asc').query).toMatchObject({
      dimensions: ['product'],
      order_by: { metric: 'units', direction: 'asc' },
      limit: 20,
    });
    const noUnits = catalogue({
      metrics: catalogue().metrics.map((m) =>
        m.id === 'units' ? { ...m, dimensions: ['store'] } : m,
      ),
    });
    expect(productsQuery(noUnits, state, 'units', 'desc').query).toBeNull();
  });
});

describe('formatting', () => {
  it('money in its own currency: JPY has no decimals; never a bare number', () => {
    expect(formatValue(120000, 'minor', 'JPY')).toBe('JP¥120,000');
    expect(formatValue(120000, 'minor', 'JPY', 'ja-JP')).toBe('￥120,000');
    expect(formatValue(4550, 'minor', 'EUR')).toBe('€45.50');
    expect(formatValue(null, 'minor', 'EUR')).toBe('—');
  });

  it('rates as %, milli as units, counts grouped', () => {
    expect(formatValue(1250, 'bp', null)).toBe('12.5 %');
    expect(formatValue(2500, 'milli', null)).toBe('2.5');
    expect(formatValue(12345, 'count', null)).toBe('12,345');
  });

  it('a change: signed amount and %, a rate change in points, a withheld % left out', () => {
    expect(formatChange(80000, 6667, 'minor', 'JPY')).toBe('+JP¥80,000 (+66.7 %)');
    expect(formatChange(-30000, null, 'minor', 'JPY')).toBe('−JP¥30,000');
    expect(formatChange(-150, -1200, 'bp', null)).toBe('−1.5 pts');
    expect(formatChange(null, null, 'count', null)).toBe('no comparison');
  });
});

describe('shaping the answers', () => {
  it('KPIs of one currency, with the comparison from compare.changes', () => {
    const result = totals(
      ['net_sales_minor', 'orders'],
      { net_sales_minor: 300000, orders: 42 },
      { net_sales_minor: 250000, orders: 40 },
    );
    expect(kpisOf([result], ['net_sales_minor', 'orders'], 'JPY')).toEqual([
      {
        metric: 'net_sales_minor',
        current: 300000,
        previous: 250000,
        change: 50000,
        changeBp: 2000,
      },
      { metric: 'orders', current: 42, previous: 40, change: 2, changeBp: 500 },
    ]);
  });

  it('breakdown rows of the chosen currency only, each with its previous values, named by labels', () => {
    const result = {
      ...totals(['net_sales_minor'], {}),
      rows: [
        { currency: 'JPY', store_id: STORE_A, values: { net_sales_minor: 200000 } },
        { currency: 'EUR', store_id: STORE_A, values: { net_sales_minor: 9900 } },
      ],
      compare: {
        ...totals(['net_sales_minor'], {}).compare!,
        rows: [{ currency: 'JPY', store_id: STORE_A, values: { net_sales_minor: 120000 } }],
      },
      labels: { store: { [STORE_A]: 'Brand A' } },
    } as unknown as MetricResult;
    expect(breakdownOf(result, 'store', 'JPY')).toEqual([
      {
        key: STORE_A,
        label: 'Brand A',
        values: { net_sales_minor: 200000 },
        previous: { net_sales_minor: 120000 },
      },
    ]);
    expect(labelOf(undefined, 'product', PROD)).toBe(`${PROD.slice(0, 8)}…`);
    expect(labelOf(undefined, 'country', 'JP')).toBe('JP');
  });
});

describe('inventory state', () => {
  it('statuses, sort and the overrides inside the API bounds; anything else ignored', () => {
    const inv = parseInventory({
      status: 'low,reorder,bogus',
      sort: 'suggested_reorder_units',
      dir: 'desc',
      page: '3',
      velocity: '5',
      lead: '0',
      cover: '45',
      dead: '400',
    });
    expect(inv).toMatchObject({
      statuses: ['low', 'reorder'],
      sort: 'suggested_reorder_units',
      direction: 'desc',
      page: 3,
      velocity: null,
      lead: 0,
      cover: 45,
      dead: null,
    });
  });

  it('the body: the store view narrowed to its store, overrides only when set', () => {
    const state = parseState({ store: STORE_B }, NOW);
    const body = inventoryQuery(state, parseInventory({ lead: '7' }), STORE_A);
    expect(body).toMatchObject({
      store_ids: [STORE_A],
      lead_time_days: 7,
      sort: 'days_of_cover',
      direction: 'asc',
      page: 1,
    });
    expect(body).not.toHaveProperty('velocity_days');
  });
});

describe('one currency at a time', () => {
  it('KPIs come from the chosen currency only, never a sum of two', () => {
    const base = totals(
      ['net_sales_minor'],
      { net_sales_minor: 300000 },
      { net_sales_minor: 250000 },
    );
    const two = {
      ...base,
      currency_totals: [
        { currency: 'JPY', values: { net_sales_minor: 300000 } },
        { currency: 'EUR', values: { net_sales_minor: 4550 } },
      ],
      compare: {
        ...base.compare!,
        changes: [
          {
            currency: 'JPY',
            metric: 'net_sales_minor',
            current: 300000,
            previous: 250000,
            change: 50000,
            change_bp: 2000,
          },
          {
            currency: 'EUR',
            metric: 'net_sales_minor',
            current: 4550,
            previous: 5000,
            change: -450,
            change_bp: -900,
          },
        ],
      },
    } as MetricResult;
    expect(kpisOf([two], ['net_sales_minor'], 'EUR')[0]).toMatchObject({
      current: 4550,
      previous: 5000,
      change: -450,
    });
    expect(kpisOf([two], ['net_sales_minor'], 'JPY')[0]).toMatchObject({ current: 300000 });
  });
});
