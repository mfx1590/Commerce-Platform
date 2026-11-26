// BI v2 wave 2 (#935): what the core answers is what the contract declares (Admin API 0.4.31). Every new shape is
// built by the REAL code and validated against admin-api.yaml: catalogue v3, a MetricResult with the new keys,
// suppressed rows and decimal hours, the cohorts, the backlog and the dimension values.
import { describe, expect, it } from 'vitest';
import { loadSpec } from '../../../http';
import { catalogueFor } from './catalogue';
import { executeMetricQuery, type MetricsReader } from './execute';
import {
  getCustomerCohorts,
  getOperationsBacklog,
  listMetricDimensionValues,
  parseCohortQuery,
  parseDimensionValuesQuery,
} from './operations';
import { parseMetricQuery } from './query';

const A = '00000000-0000-4000-8000-000000000031';
const G = '00000000-0000-4000-8000-000000000041';
const W = '00000000-0000-4000-8000-000000000051';
const spec = loadSpec('admin-api.yaml');
function conforms(name: string, body: unknown) {
  const validate = spec.schema(name);
  expect(validate(body), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

const reader = (rows: Record<string, unknown>[]): MetricsReader => ({
  async query({ query }) {
    if (query.includes('FROM raw_events'))
      return { json: async <T>() => [{ t: '2026-11-02 00:00:00.000' }] as T[] };
    return { json: async <T>() => rows as T[] };
  },
});

describe('BI v2 wave 2 shapes = admin-api.yaml 0.4.31', () => {
  it('listMetrics: catalogue v3', () => {
    conforms(
      'MetricCatalogue',
      catalogueFor({ finance: true, stores: [{ id: A, code: 'brand-a' }] }),
    );
  });

  it('queryMetrics: customer groups with a suppressed row, decimal hours, utm and failure keys', async () => {
    const customers = await executeMetricQuery(
      reader([
        {
          out_store: A,
          out_currency: 'EUR',
          out_cgroup: G,
          m_customers: '2',
          m_customer_net_sales_minor: '900',
        },
        {
          out_store: A,
          out_currency: 'EUR',
          out_cgroup: null,
          m_customers: '8',
          m_customer_net_sales_minor: '4000',
        },
      ]),
      parseMetricQuery({
        metrics: ['revenue_per_customer_minor'],
        dimensions: ['customer_group'],
        grain: 'total',
        from: '2026-10-01',
        to: '2026-11-01',
      }),
      [A],
    );
    expect(customers.rows.some((r) => r.suppressed)).toBe(true);
    conforms('MetricResult', customers);
    const hours = await executeMetricQuery(
      reader([
        { out_warehouse: W, out_carrier: 'dhl', m_hours_to_ship_p50: 10.5, m_orders_shipped: '3' },
      ]),
      parseMetricQuery({
        metrics: ['hours_to_ship_p50', 'orders_shipped'],
        dimensions: ['warehouse', 'carrier'],
        grain: 'total',
        from: '2026-10-01',
        to: '2026-11-01',
        compare: 'previous_period',
      }),
      [A],
    );
    expect(hours.rows[0]!.values.hours_to_ship_p50).toBe(10.5);
    conforms('MetricResult', hours);
  });

  it('getCustomerCohorts, getOperationsBacklog and listMetricDimensionValues', async () => {
    const q = parseCohortQuery({
      from_month: '2026-01',
      to_month: '2026-02',
      months: 3,
      currency: 'EUR',
    });
    const cohorts = await getCustomerCohorts(
      {
        async query({ query }) {
          const rows = query.includes('m_size')
            ? [{ out_cohort: '2026-01-01', m_size: '12' }]
            : [
                { out_cohort: '2026-01-01', out_offset: 0, m_active: '12', m_net: '24000' },
                { out_cohort: '2026-01-01', out_offset: 1, m_active: '3', m_net: '3000' },
              ];
          return { json: async <T>() => rows as T[] };
        },
      },
      q,
      [A],
      new Date('2026-11-19T00:00:00Z'),
    );
    expect(cohorts.cohorts[0]!.cells[1]!.suppressed).toBe(true);
    conforms('CustomerCohorts', cohorts);
    const backlog = await getOperationsBacklog(
      {
        query: async () =>
          ({
            rows: [
              { kind: 'unassigned', store_id: A, warehouse_id: null, bucket: 'gt_7d', count: 3 },
            ],
          }) as never,
      },
      [A],
    );
    conforms('OperationsBacklog', backlog);
    const values = await listMetricDimensionValues(
      {
        pg: { query: async () => ({ rows: [{ id: A, label: 'Brand A' }] }) as never },
        reader: reader([]),
      },
      parseDimensionValuesQuery({ dimension: 'store' }),
      [A],
    );
    conforms('MetricDimensionValues', values);
  });
});
