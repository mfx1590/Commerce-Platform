// BI v2 (#871): what the core answers is what the contract declares (Admin API 0.4.30). Every new or changed shape is
// built by the REAL code (no hand-written fixture of the answer) and validated against admin-api.yaml's schemas.
import { createFakeTransport, type AiRequest } from '@platform/ai';
import { describe, expect, it } from 'vitest';
import { loadSpec } from '../../../http';
import { askMetrics } from '../ask/ask';
import { callerFor, realGateway } from '../ask/golden/run';
import { STOCK_NOW, STOCK_QUESTION, stockAnswerFrom, stockFixture } from '../ask/golden/stock';
import { catalogueFor } from './catalogue';
import { executeMetricQuery, type MetricsReader } from './execute';
import { computeInventoryHealth, parseInventoryQuery } from './inventory';
import { moversFromResult, moversMetricQuery, parseMoversQuery } from './movers';
import { parseMetricQuery } from './query';

const A = '00000000-0000-4000-8000-000000000031';
const B = '00000000-0000-4000-8000-000000000032';
const spec = loadSpec('admin-api.yaml');
function conforms(name: string, body: unknown) {
  const validate = spec.schema(name);
  expect(validate(body), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

/** A reader answering every source with one row per store (current and previous range differ). */
const reader: MetricsReader = {
  async query({ query, query_params }) {
    if (query.includes('FROM raw_events'))
      return { json: async <T>() => [{ t: '2026-11-02 00:00:00.000' }] as T[] };
    const current = query_params?.from === '2026-10-01';
    const rows = [A, B].map((s, i) => ({
      out_period: null,
      out_store: s,
      out_currency: 'EUR',
      out_country: i === 0 ? 'DE' : '',
      m_net_sales_minor: String(current ? 1500 + i : 1000),
      m_orders: '3',
      m_units: '7',
    }));
    return { json: async <T>() => rows as T[] };
  },
};

describe('BI v2 shapes = admin-api.yaml 0.4.30', () => {
  it('the request bodies the operations take are the contract’s', () => {
    conforms('MetricQuery', {
      metrics: ['net_sales_minor'],
      dimensions: ['country', 'customer_type'],
      grain: 'day',
      from: '2026-10-01',
      to: '2026-11-01',
      filters: { countries: ['DE'], customer_types: ['new'], sales_channel_ids: [B] },
      compare: 'previous_year',
    });
    conforms('MetricMoversQuery', {
      metric: 'net_sales_minor',
      dimension: 'store',
      from: '2026-10-01',
      to: '2026-11-01',
      compare: 'previous_period',
      min_base: 0,
      limit: 5,
    });
    conforms('InventoryHealthQuery', {
      status: ['stock_out', 'low', 'reorder'],
      lead_time_days: 14,
      cover_days: 28,
      velocity_days: 28,
      dead_days: 60,
      sort: 'days_of_cover',
      direction: 'asc',
      page: 1,
      limit: 100,
    });
  });

  it('listMetrics: catalogue v2', () => {
    for (const finance of [false, true])
      conforms('MetricCatalogue', catalogueFor({ finance, stores: [{ id: A, code: 'brand-a' }] }));
  });

  it('queryMetrics: the new row keys, compare and labels', async () => {
    const q = parseMetricQuery({
      metrics: ['net_sales_minor', 'items_per_order_bp'],
      dimensions: ['store', 'country'],
      grain: 'total',
      from: '2026-10-01',
      to: '2026-11-01',
      compare: 'previous_period',
    });
    const r = await executeMetricQuery(reader, q, [A, B]);
    r.labels = { store: { [A]: 'Brand A', [B]: 'Brand B' } };
    conforms('MetricResult', r);
    expect(r.compare!.changes.length).toBeGreaterThan(0);
  });

  it('listMetricMovers', async () => {
    const mq = parseMoversQuery({
      metric: 'net_sales_minor',
      dimension: 'store',
      from: '2026-10-01',
      to: '2026-11-01',
    });
    const r = await executeMetricQuery(reader, moversMetricQuery(mq), [A, B]);
    conforms('MetricMovers', {
      ...moversFromResult(mq, r, new Date()),
      labels: { store: { [A]: 'Brand A' } },
    });
  });

  it('getInventoryHealth, and its degraded answer', () => {
    const fx = stockFixture(A, B);
    const q = parseInventoryQuery({});
    conforms(
      'InventoryHealth',
      computeInventoryHealth(fx, q, { organization: true, now: STOCK_NOW }),
    );
    conforms(
      'InventoryHealth',
      computeInventoryHealth({ ...fx, sales: null }, q, { organization: false, now: STOCK_NOW }),
    );
  });

  it('askMetrics: the stock answer with inventory[] and labels (the #871 addendum)', async () => {
    const transport = createFakeTransport({
      script: [
        {
          toolUse: [
            { name: 'inventory_health', input: { status: ['stock_out', 'low', 'reorder'] } },
          ],
        },
        (req: AiRequest) => ({
          text: stockAnswerFrom(
            (req.turns ?? []).flatMap((t) => (t.role === 'user' ? t.toolResults : []))[0]!.content,
          ),
        }),
      ],
    });
    const stores = { A: { id: A, code: 'brand-a' }, B: { id: B, code: 'brand-b' } };
    const answer = await askMetrics(
      {
        reader,
        gatewayFor: realGateway(transport),
        biQaSwitches: async () => new Map(),
        now: () => STOCK_NOW,
        inventory: async (_ids, q) =>
          computeInventoryHealth(stockFixture(A, B), q, { organization: true, now: STOCK_NOW }),
        labels: async () => ({}),
      },
      callerFor('analyst', stores),
      { question: STOCK_QUESTION },
    );
    conforms('MetricAnswer', answer);
    expect(answer.inventory).toHaveLength(1);
    // the check is not vacuous: one field the contract does not declare fails it
    expect(spec.schema('MetricAnswer')({ ...answer, surprise: 1 })).toBe(false);
    expect(
      spec.schema('InventoryHealth')({ ...answer.inventory![0]!.result!, rows: [{ sku: 'x' }] }),
    ).toBe(false);
  });
});
