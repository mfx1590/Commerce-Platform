// BI v2 (#871) without any service: the catalogue v2 rules, the new sources and their scopes, `compare` by offset,
// movers' ranking, the inventory computation (the owner's question) and the CSV opt-in. The ClickHouse and HTTP sides
// run in metrics-live.test.ts.
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../lib/errors';
import { catalogueFor, isAdditive, METRIC_IDS, METRICS } from './catalogue';
import { compileMetricQuery } from './compile';
import { renderInventoryCsv, renderMetricCsv } from './csv';
import { executeMetricQuery, scopedEverywhere, type MetricsReader } from './execute';
import {
  computeInventoryHealth,
  parseInventoryQuery,
  type InventoryInputs,
  type MappingRow,
  type PositionRow,
} from './inventory';
import { idsOf, resolveLabels } from './labels';
import { defaultMinBase, listMetricMovers, parseMoversQuery, rankMovers } from './movers';
import { Aliases, biQaToolHandler, type ExecutedQuery } from '../ask/tool';
import { comparisonRange, parseMetricQuery } from './query';

const A = '00000000-0000-4000-8000-000000000031';
const B = '00000000-0000-4000-8000-000000000032';
const ORG = '00000000-0000-4000-8000-000000000001';
const base = { grain: 'total', from: '2026-10-01', to: '2026-11-01' };

function err(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? { code: e.code, details: e.details } : e;
  }
  return 'no error';
}

describe('catalogue v2', () => {
  it('every metric is a source, a derivation or a snapshot, and lists the dimensions its source can group by', () => {
    for (const id of METRIC_IDS) {
      const m = METRICS[id];
      expect(Boolean(m.source) || Boolean(m.derived) || m.kind === 'snapshot', id).toBe(true);
      expect(m.description.length, id).toBeGreaterThan(20);
    }
    const c = catalogueFor({ finance: false, stores: [{ id: A, code: 'brand-a' }] });
    expect(c.version).toBe(3); // #935: catalogue version 3
    expect(c.inventory_defaults).toEqual({
      velocity_days: 28,
      lead_time_days: 14,
      cover_days: 28,
      dead_days: 60,
    });
    expect(c.dimensions.map((d) => d.id)).toContain('customer_type');
    expect(c.metrics.find((m) => m.id === 'stock_available')).toMatchObject({ kind: 'snapshot' });
  });

  it('additive = sums of money or counts only (movers rank nothing else)', () => {
    expect(isAdditive(METRICS.net_sales_minor)).toBe(true);
    expect(isAdditive(METRICS.units)).toBe(true);
    expect(isAdditive(METRICS.aov_minor)).toBe(false); // derived
    expect(isAdditive(METRICS.refund_rate_bp)).toBe(false);
    expect(isAdditive(METRICS.product_orders)).toBe(false); // a distinct count
    expect(isAdditive(METRICS.stock_available)).toBe(false); // snapshot
    expect(isAdditive(METRICS.live_orders)).toBe(false);
  });

  it('the tax bases are written into the definitions (#871 review 4)', () => {
    expect(METRICS.bookings_minor.description).toMatch(/tax-inclusive stores/);
    expect(METRICS.product_net_minor.description).toMatch(/tax included on both price bases/);
    expect(METRICS.net_sales_minor.source!.sql).toBe('sum(total_minor - tax_minor)');
    expect(METRICS.discounts_minor.description).toMatch(/Free shipping is not included/);
    expect(METRICS.stock_incoming.description).toMatch(/does NOT mean nothing is on order/);
  });
});

describe('parseMetricQuery v2', () => {
  it('refuses a snapshot metric (inventory now is getInventoryHealth’s)', () => {
    expect(err(() => parseMetricQuery({ ...base, metrics: ['days_of_cover'] }))).toMatchObject({
      code: 'validation_error',
      details: { metric: 'days_of_cover', reason: 'snapshot_metric' },
    });
  });

  it('takes the new filters, refuses bad values', () => {
    const q = parseMetricQuery({
      ...base,
      metrics: ['net_sales_minor'],
      dimensions: ['country', 'customer_type'],
      filters: {
        countries: ['DE', 'JP'],
        customer_types: ['new'],
        category_ids: [B.toUpperCase()],
      },
    });
    expect(q.filters).toEqual({
      countries: ['DE', 'JP'],
      customer_types: ['new'],
      category_ids: [B],
    });
    expect(
      err(() => parseMetricQuery({ ...base, metrics: ['units'], filters: { countries: ['de'] } })),
    ).toMatchObject({
      code: 'validation_error',
    });
    expect(
      err(() =>
        parseMetricQuery({ ...base, metrics: ['units'], filters: { customer_types: ['vip'] } }),
      ),
    ).toMatchObject({ code: 'validation_error' });
  });

  it('a pair the catalogue refuses is a 400 (customer counts by country)', () => {
    expect(
      err(() => parseMetricQuery({ ...base, metrics: ['new_customers'], dimensions: ['country'] })),
    ).toMatchObject({
      code: 'validation_error',
      details: { metric: 'new_customers', dimension: 'country' },
    });
  });
});

describe('compare: matched by offset (#871 review 9)', () => {
  it('previous_period moves by the range length; month grain needs whole months; previous_year clamps 29 February', () => {
    expect(
      comparisonRange({ from: '2026-10-01', to: '2026-10-29', grain: 'day' }, 'previous_period'),
    ).toEqual({
      from: '2026-09-03',
      to: '2026-10-01',
      offset: '-28d',
    });
    expect(
      comparisonRange({ from: '2026-10-01', to: '2027-01-01', grain: 'month' }, 'previous_period'),
    ).toEqual({
      from: '2026-07-01',
      to: '2026-10-01',
      offset: '-3M',
    });
    expect(
      err(() =>
        comparisonRange(
          { from: '2026-10-05', to: '2026-11-01', grain: 'month' },
          'previous_period',
        ),
      ),
    ).toMatchObject({ code: 'validation_error', details: { field: 'compare' } });
    expect(
      comparisonRange({ from: '2028-02-29', to: '2028-03-01', grain: 'day' }, 'previous_year'),
    ).toEqual({
      from: '2027-02-28',
      to: '2027-03-01',
      offset: '-1Y',
    });
    // parse refuses it up front
    expect(
      err(() =>
        parseMetricQuery({
          ...base,
          metrics: ['orders'],
          grain: 'month',
          from: '2026-10-05',
          compare: 'previous_period',
        }),
      ),
    ).toMatchObject({ code: 'validation_error' });
  });

  it('executes both ranges; changes per currency; the % is null on a zero base', async () => {
    const reader: MetricsReader = {
      async query({ query, query_params }) {
        if (query.includes('FROM raw_events'))
          return { json: async <T>() => [{ t: '2026-11-02 00:00:00.000' }] as T[] };
        const current = query_params?.from === '2026-10-01';
        const rows = current
          ? [
              { out_period: null, out_currency: 'EUR', m_net_sales_minor: '1500' },
              { out_period: null, out_currency: 'JPY', m_net_sales_minor: '9000' },
            ]
          : [{ out_period: null, out_currency: 'EUR', m_net_sales_minor: '1000' }];
        return { json: async <T>() => rows as T[] };
      },
    };
    const q = parseMetricQuery({
      ...base,
      metrics: ['net_sales_minor'],
      compare: 'previous_period',
    });
    const r = await executeMetricQuery(reader, q, [A]);
    expect(r.compare).toMatchObject({
      mode: 'previous_period',
      from: '2026-08-31',
      to: '2026-10-01',
      offset: '-31d',
    });
    expect(r.compare!.current_incomplete).toBe(false);
    expect(r.compare!.changes).toEqual([
      {
        currency: 'EUR',
        metric: 'net_sales_minor',
        current: 1500,
        previous: 1000,
        change: 500,
        change_bp: 5000,
      },
      {
        currency: 'JPY',
        metric: 'net_sales_minor',
        current: 9000,
        previous: null,
        change: null,
        change_bp: null,
      },
    ]);
  });
});

describe('the new sources and the stock scope (#871 review 1)', () => {
  it('sales, lines, returns are store-scoped; stock is scoped by organization or by mapped stock items', () => {
    const sales = compileMetricQuery(
      parseMetricQuery({ ...base, metrics: ['placed_orders'], dimensions: ['country'] }),
      [A],
    );
    expect(sales.sources[0]!.sql).toContain('FROM mart_sales_daily');
    expect(sales.sources[0]!.sql).toContain('store_id IN {scope:Array(UUID)}');
    const ret = compileMetricQuery(
      parseMetricQuery({ ...base, metrics: ['return_rate_bp'], dimensions: ['category'] }),
      [A],
    );
    expect(ret.sources.map((s) => s.source).sort()).toEqual(['lines', 'returns']);
    const stockQ = parseMetricQuery({
      ...base,
      metrics: ['units_received'],
      dimensions: ['warehouse'],
    });
    expect(() => compileMetricQuery(stockQ, [A])).toThrow(/stock scope/);
    const org = compileMetricQuery(stockQ, [A], { stock: { organizationId: ORG } });
    expect(org.sources[0]!.sql).toContain('organization_id = {org:UUID}');
    expect(org.sources[0]!.sql).not.toContain('store_id IN');
    const items = compileMetricQuery(stockQ, [A], { stock: { stockItemIds: [B] } });
    expect(items.sources[0]!.sql).toContain(
      '(stock_item_id IN {items:Array(UUID)} OR (stock_item_id IS NULL AND store_id IN {scope:Array(UUID)}))',
    );
    expect(items.sources[0]!.params.items).toEqual([B]);
    expect(scopedEverywhere(stockQ, [A], { stockItemIds: [B] })).toBe(true);
  });

  it('a new filter a source cannot apply is a 400; one it can becomes a parameter, never text', () => {
    const q = parseMetricQuery({
      ...base,
      metrics: ['units_received'],
      filters: { countries: ['DE'] },
    });
    expect(err(() => compileMetricQuery(q, [A], { stock: { organizationId: ORG } }))).toMatchObject(
      {
        code: 'validation_error',
        details: { field: 'filters.countries' },
      },
    );
    const ok = compileMetricQuery(
      parseMetricQuery({
        ...base,
        metrics: ['net_sales_minor'],
        filters: { countries: ['DE'], customer_types: ['new'] },
      }),
      [A],
    );
    expect(ok.sources[0]!.sql).toContain('country IN {countries:Array(String)}');
    expect(ok.sources[0]!.sql).not.toContain("'DE'");
    expect(ok.sources[0]!.params.ctypes).toEqual(['new']);
  });
});

describe('movers (#871 review 8)', () => {
  it('only additive metrics, a pair the catalogue accepts, limit ≤ 20', () => {
    expect(
      err(() =>
        parseMoversQuery({
          metric: 'refund_rate_bp',
          dimension: 'store',
          from: '2026-10-01',
          to: '2026-11-01',
        }),
      ),
    ).toMatchObject({
      code: 'validation_error',
      details: { field: 'metric' },
    });
    // golden question 1's old pair (bookings by product) is refused; product_net_minor by product is the one
    expect(
      err(() =>
        parseMoversQuery({
          metric: 'bookings_minor',
          dimension: 'product',
          from: '2026-10-01',
          to: '2026-11-01',
        }),
      ),
    ).toMatchObject({
      code: 'validation_error',
    });
    expect(
      parseMoversQuery({
        metric: 'product_net_minor',
        dimension: 'product',
        from: '2026-10-01',
        to: '2026-11-01',
      }),
    ).toMatchObject({
      compare: 'previous_period',
      limit: 5,
    });
    expect(
      err(() =>
        parseMoversQuery({
          metric: 'units',
          dimension: 'product',
          from: '2026-10-01',
          to: '2026-11-01',
          limit: 21,
        }),
      ),
    ).toMatchObject({
      code: 'validation_error',
    });
  });

  it('ranks by absolute change inside each currency; % null below the base; new and gone flagged', () => {
    const cur = new Map<string | null, Map<string, number>>([
      [
        'EUR',
        new Map([
          ['a', 300_000],
          ['b', 100_000],
          ['c', 500],
          ['n', 2000],
        ]),
      ],
      ['JPY', new Map([['a', 5000]])],
    ]);
    const prev = new Map<string | null, Map<string, number>>([
      [
        'EUR',
        new Map([
          ['a', 200_000],
          ['b', 150_000],
          ['c', 100],
          ['g', 7000],
        ]),
      ],
      ['JPY', new Map([['a', 4000]])],
    ]);
    const [eur, jpy] = rankMovers(cur, prev, { limit: 5 });
    expect(eur!.risers.map((m) => m.key)).toEqual(['a', 'n', 'c']); // +100 000 before a tiny base's +400
    expect(eur!.risers[2]).toMatchObject({ key: 'c', change: 400, change_bp: null }); // 100 < 1000 (10 EUR)
    expect(eur!.risers[1]).toMatchObject({ key: 'n', is_new: true, change_bp: null });
    expect(eur!.fallers.map((m) => m.key)).toEqual(['b', 'g']);
    expect(eur!.fallers[1]).toMatchObject({ key: 'g', is_gone: true, change_bp: -10_000 });
    // yen ranked in its own block, its base 10 yen (exponent 0)
    expect(jpy).toMatchObject({
      currency: 'JPY',
      risers: [{ key: 'a', change: 1000, change_bp: 2500 }],
    });
    expect(defaultMinBase('JPY')).toBe(10);
    expect(defaultMinBase('EUR')).toBe(1000);
    expect(defaultMinBase(null)).toBe(10);
  });
});

// ---- inventory: the owner's question, computed --------------------------------------------------------------------

const NOW = new Date('2026-11-13T15:00:00.000Z');
const W1 = '00000000-0000-4000-8000-0000000000a1';
const W2 = '00000000-0000-4000-8000-0000000000a2';
const item = (n: number) => `00000000-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;
const variant = (n: number) =>
  `00000000-0000-4000-8000-0000000v${String(n).padStart(4, '0')}`.replace('v', 'f');

function pos(n: number, wh: string, onHand: number, reserved = 0): PositionRow {
  return {
    stock_item_id: item(n),
    sku: `SKU-${n}`,
    name: `Item ${n}`,
    warehouse_id: wh,
    warehouse_code: wh === W1 ? 'BER' : 'TYO',
    on_hand: onHand,
    reserved,
    available: onHand - reserved,
    incoming: 0,
  };
}
const map = (n: number, store = A): MappingRow => ({
  stock_item_id: item(n),
  variant_id: variant(n),
  store_id: store,
  product_id: item(n),
  category_id: null,
});
/** `perDay` units every day of the last `days` full days (today excluded) */
const daily = (n: number, perDay: number, days = 28) =>
  Array.from({ length: days }, (_, i) => ({
    variant_id: variant(n),
    day: new Date(Date.parse('2026-11-13T00:00:00Z') - (i + 1) * 86_400_000)
      .toISOString()
      .slice(0, 10),
    units: perDay,
  }));

function inputs(over: Partial<InventoryInputs> = {}): InventoryInputs {
  return {
    // 1: 2 a day, 20 available in two warehouses → 10 days of cover < lead 14 → low; suggestion ⌈2 × 42⌉ − 20 = 64
    // 2: out of stock (−3 available), no sale in the window → stock_out, suggestion 3 (the backorder)
    // 3: 1 a day, 200 available → 200 days > 3 × 42 → overstock
    // 4: stock, no sale ever → dead
    // 5: 1 a day, 30 available → 30 < 42 → reorder; stocked out 5 days ago → rate_understated
    positions: [
      pos(1, W1, 12),
      pos(1, W2, 8),
      pos(2, W1, 2, 5),
      pos(3, W1, 200),
      pos(4, W1, 40),
      pos(5, W2, 30),
    ],
    mappings: [map(1), map(2), map(3), map(4), map(5)],
    shared: new Set([item(1)]),
    settings: new Map(),
    sales: {
      byDay: [
        ...daily(1, 2),
        ...daily(3, 1),
        ...daily(5, 1),
        { variant_id: variant(1), day: '2026-11-13', units: 99 },
      ],
      lastSale: new Map([
        [variant(1), '2026-11-12T10:00:00.000Z'],
        [variant(2), '2026-08-01T10:00:00.000Z'],
        [variant(3), '2026-11-12T10:00:00.000Z'],
        [variant(5), '2026-11-12T10:00:00.000Z'],
      ]),
      stockoutDays: new Map([[item(5), ['2026-11-08']]]),
      lastReceipt: new Map([[`${item(1)}|${W1}`, '2026-10-01T00:00:00.000Z']]),
      data_as_of: '2026-11-13T14:59:00.000Z',
    },
    ...over,
  };
}

describe('getInventoryHealth: the computation (#871 a1, review 2 and 3)', () => {
  const q = parseInventoryQuery({});

  it('the owner’s question: which items, their cover and the suggested quantity, per STOCK ITEM', () => {
    const r = computeInventoryHealth(
      inputs(),
      { ...q, sort: 'sku' },
      { organization: true, now: NOW },
    );
    const by = Object.fromEntries(r.rows.map((x) => [x.sku, x]));
    // item 1: the two warehouses summed (20), today's 99 excluded from the rate (full days only)
    expect(by['SKU-1']).toMatchObject({
      available: 20,
      units_sold: 56,
      units_sold_per_day_milli: 2000,
      days_of_cover: 10,
      status: 'low',
      suggested_reorder_units: 64,
      shared: true,
      suggestion_partial: false, // HQ's view is the pool's
      parameters_source: 'default',
    });
    expect(by['SKU-1']!.warehouses.map((w) => w.warehouse_code)).toEqual(['BER', 'TYO']);
    // item 2: a stock-out with no sale in the window stays on the list (review 3)
    expect(by['SKU-2']).toMatchObject({
      available: -3,
      status: 'stock_out',
      days_of_cover: 0,
      suggested_reorder_units: 3,
      rate_understated: true,
    });
    expect(by['SKU-3']).toMatchObject({
      status: 'overstock',
      days_of_cover: 200,
      suggested_reorder_units: 0,
    });
    expect(by['SKU-4']).toMatchObject({ status: 'dead', days_of_cover: null, last_sale_at: null });
    expect(by['SKU-5']).toMatchObject({
      status: 'reorder',
      days_of_cover: 30,
      suggested_reorder_units: 12,
      rate_understated: true,
    });
    expect(r.summary).toEqual({ low: 1, stock_out: 1, overstock: 1, dead: 1, reorder: 1 });
    expect(r.incoming_tracked).toBe(false);
    expect(r.rate_available).toBe(true);
  });

  it('a store caller: own rate only, the shared pool flagged, the suggestion partial', () => {
    const r = computeInventoryHealth(inputs(), q, { organization: false, now: NOW });
    expect(r.rows.find((x) => x.sku === 'SKU-1')).toMatchObject({
      shared: true,
      suggestion_partial: true,
    });
    expect(r.rows.find((x) => x.sku === 'SKU-3')).toMatchObject({
      shared: false,
      suggestion_partial: false,
    });
  });

  it('parameters: request > the largest setting among the item’s caller-visible stores > default', () => {
    const many = inputs({
      mappings: [map(1, A), { ...map(1, B), variant_id: variant(9) }],
      settings: new Map([
        [A, { lead_time_days: 20 }],
        [B, { lead_time_days: 30, cover_days: 10 }],
      ]),
    });
    const r = computeInventoryHealth(many, q, { organization: true, now: NOW });
    expect(r.rows.find((x) => x.sku === 'SKU-1')).toMatchObject({
      parameters: { velocity_days: 28, lead_time_days: 30, cover_days: 10, dead_days: 60 },
      parameters_source: 'store',
    });
    const req = computeInventoryHealth(
      many,
      { ...q, velocity_days: 7, lead_time_days: 1, cover_days: 1, dead_days: 14 },
      { organization: true, now: NOW },
    );
    expect(req.rows.find((x) => x.sku === 'SKU-1')!.parameters_source).toBe('request');
  });

  it('a warehouse filter narrows the stock side only; status and paging; the analytics store down (review 12)', () => {
    const w2 = computeInventoryHealth(
      inputs(),
      { ...q, warehouse_ids: [W2] },
      { organization: true, now: NOW },
    );
    expect(w2.rows.map((x) => x.sku).sort()).toEqual(['SKU-1', 'SKU-5']);
    expect(w2.rows.find((x) => x.sku === 'SKU-1')).toMatchObject({
      available: 8,
      days_of_cover: 4,
    });
    const lows = computeInventoryHealth(
      inputs(),
      { ...q, status: ['stock_out', 'low', 'reorder'] },
      { organization: true, now: NOW },
    );
    expect(lows.rows.map((x) => x.sku)).toEqual(['SKU-2', 'SKU-1', 'SKU-5']); // by days of cover, ascending
    expect(lows.total).toBe(3);
    expect(lows.summary.overstock).toBe(1); // the chips count every status
    const down = computeInventoryHealth(inputs({ sales: null }), q, {
      organization: true,
      now: NOW,
    });
    expect(down.rate_available).toBe(false);
    expect(down.rows.find((x) => x.sku === 'SKU-2')).toMatchObject({
      status: 'stock_out',
      suggested_reorder_units: null,
    });
    expect(down.rows.find((x) => x.sku === 'SKU-1')).toMatchObject({
      status: null,
      days_of_cover: null,
      units_sold: null,
    });
  });

  it('parseInventoryQuery bounds every parameter', () => {
    expect(err(() => parseInventoryQuery({ lead_time_days: 181 }))).toMatchObject({
      code: 'validation_error',
    });
    expect(err(() => parseInventoryQuery({ velocity_days: 6 }))).toMatchObject({
      code: 'validation_error',
    });
    expect(err(() => parseInventoryQuery({ status: ['soon'] }))).toMatchObject({
      code: 'validation_error',
    });
    expect(err(() => parseInventoryQuery({ limit: 501 }))).toMatchObject({
      code: 'validation_error',
    });
    expect(err(() => parseInventoryQuery({ sql: 'x' }))).toMatchObject({
      code: 'validation_error',
    });
  });

  it('the CSV: one line per item × warehouse, the reorder list a supplier can be sent', () => {
    const r = computeInventoryHealth(
      inputs(),
      { ...q, sort: 'sku' },
      { organization: true, now: NOW },
    );
    const lines = renderInventoryCsv(r).trimEnd().split('\r\n');
    expect(lines.length).toBe(1 + 6);
    expect(lines[1]).toContain('"SKU-1","Item 1","BER",12,0,12,20');
  });
});

describe('labels and the CSV opt-in (#871 review 10)', () => {
  it('one batched query per entity type, only for the ids the rows hold', async () => {
    const seen: string[] = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        seen.push(sql);
        const ids = (params?.[0] as string[]) ?? [];
        return { rows: ids.map((id) => ({ id, label: `L-${id.slice(-2)}` })) } as never;
      },
    };
    const labels = await resolveLabels(
      client,
      idsOf([
        { store_id: A, product_id: B },
        { store_id: A, product_id: null },
      ]),
    );
    expect(labels).toEqual({ store: { [A]: 'L-31' }, product: { [B]: 'L-32' } });
    expect(seen).toHaveLength(2);
  });

  it('labels in CSV only with labels=true, appended after the documented columns', () => {
    const result = {
      query: parseMetricQuery({ ...base, metrics: ['units'], dimensions: ['store'] }),
      generated_at: '',
      data_as_of: null,
      truncated: false,
      rows: [
        {
          period: null,
          currency: null,
          store_id: A,
          product_id: null,
          refund_reason: null,
          provider: null,
          country: null,
          sales_channel_id: null,
          category_id: null,
          customer_type: null,
          warehouse_id: null,
          values: { units: 3 },
        },
      ],
      currency_totals: [],
      labels: { store: { [A]: 'Brand A' } },
    };
    expect(renderMetricCsv(result)).toBe(
      `"period","currency","store_id","units"\r\n,,"${A}",3\r\n`,
    );
    expect(renderMetricCsv(result, { labels: true })).toBe(
      `"period","currency","store_id","units","store_label"\r\n,,"${A}",3,"Brand A"\r\n`,
    );
  });
});

describe('the store-scoped stock series limit (#908)', () => {
  it('above 2 500 mapped stock items: a clear validation_error, never a ClickHouse one', async () => {
    const { MAX_STOCK_SCOPE_ITEMS, stockScopeTooLarge } = await import('./routes');
    expect(MAX_STOCK_SCOPE_ITEMS).toBe(2500);
    const e = stockScopeTooLarge(3100);
    expect(e).toMatchObject({
      code: 'validation_error',
      details: { reason: 'stock_scope_too_large', items: 3100, max: 2500 },
    });
    expect(e.message).toMatch(/#908/);
  });
});

describe('movers rank over EVERY key of both ranges, never a 1 000-row slice (#924 review)', () => {
  // 1 500 products in two currencies. The true top riser in EUR sorts at position 1 400, the one in JPY at 1 200: a
  // slice of the first 1 000 rows (sorted by key) would miss both, and a product present in both ranges but past the
  // slice in one of them would come back as a false is_new / is_gone.
  const N = 1500;
  const pid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const big: MetricsReader = {
    async query({ query, query_params }) {
      if (query.includes('FROM raw_events'))
        return { json: async <T>() => [{ t: '2026-11-02 00:00:00.000' }] as T[] };
      const current = query_params?.from === '2026-10-01';
      const rows = [];
      for (let i = 0; i < N; i++)
        for (const currency of ['EUR', 'JPY']) {
          let v = 1000 + i; // the same in both ranges: no movement at all
          if (current && currency === 'EUR' && i === 1400) v += 1_000_000;
          if (current && currency === 'JPY' && i === 1200) v += 50_000;
          if (current && currency === 'EUR' && i === 1450) v -= 1400; // the largest fall
          rows.push({
            out_period: null,
            out_product: pid(i),
            out_currency: currency,
            m_product_net_minor: String(v),
          });
        }
      return { json: async <T>() => rows as T[] };
    },
  };
  const mq = () =>
    parseMoversQuery({
      metric: 'product_net_minor',
      dimension: 'product',
      from: '2026-10-01',
      to: '2026-11-01',
      limit: 3,
    });

  it('listMetricMovers: the true movers per currency, no false new or gone', async () => {
    const r = await listMetricMovers(big, mq(), [A]);
    const eur = r.by_currency.find((b) => b.currency === 'EUR')!;
    const jpy = r.by_currency.find((b) => b.currency === 'JPY')!;
    expect(eur.risers.map((m) => m.key)).toEqual([pid(1400)]);
    expect(eur.fallers.map((m) => m.key)).toEqual([pid(1450)]);
    expect(jpy.risers.map((m) => m.key)).toEqual([pid(1200)]);
    for (const b of r.by_currency)
      for (const m of [...b.risers, ...b.fallers]) {
        expect(m.is_new, m.key).toBe(false);
        expect(m.is_gone, m.key).toBe(false);
      }
    // the totals are over every key too
    expect(eur.total_current! - eur.total_previous!).toBe(1_000_000 - 1400);
  });

  it('the Ask movers tool ranks the same way; the answer records the result capped like any query', async () => {
    const executed: ExecutedQuery[] = [];
    const aliases = new Aliases();
    const handle = biQaToolHandler({
      reader: big,
      caller: { stores: [A], finance: () => false },
      executed,
      aliases,
    });
    const out = await handle({
      id: 't1',
      name: 'movers',
      input: {
        metric: 'product_net_minor',
        dimension: 'product',
        from: '2026-10-01',
        to: '2026-11-01',
        limit: 3,
      },
    });
    const body = JSON.parse(out.content) as {
      by_currency: { currency: string; risers: { key: string }[] }[];
    };
    const eurTop = body.by_currency.find((b) => b.currency === 'EUR')!.risers[0]!.key;
    expect(aliases.reverse.get(eurTop)).toEqual({ kind: 'product', id: pid(1400) });
    const recorded = executed[0]!.result!;
    expect(recorded.rows).toHaveLength(1000);
    expect(recorded.truncated).toBe(true);
    expect(recorded.compare!.truncated).toBe(true);
  });
});
