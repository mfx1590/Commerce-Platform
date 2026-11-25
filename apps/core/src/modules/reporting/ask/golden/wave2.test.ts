// #935 e's acceptance: the eight owner questions of BI v2 wave 2 through askMetrics on the REAL AI gateway (fake
// transport, scripted model), the real tools over a deterministic fixture (ClickHouse answers by model, Postgres
// promotions, cohorts and the backlog), and the server-side alias substitution. Each answer is CONCRETE, and the
// checks any answer — scripted now, a real model's later — must pass:
//   * the figures the question needs, named (campaigns, promotions, warehouses by name, never an alias);
//   * every number of a metrics answer is in a result (money as major units, a rate as %), none invented;
//   * the caveat each question carries: a PLANNED budget (not spend); recovery only over default-currency carts and
//     never divided by the all-currency count; time to ship over shipped orders; failure codes as the PSP sends them;
//     cohorts of fewer than 5 customers withheld; the backlog is now;
//   * no alias left in the text, and no name or id ever sent to the model.
import { createFakeTransport, type AiRequest } from '@platform/ai';
import { describe, expect, it } from 'vitest';
import { MIN_CUSTOMERS, type MetricId } from '../../metrics/catalogue';
import type { MetricsReader } from '../../metrics/execute';
import { getCustomerCohorts } from '../../metrics/operations';
import { askMetrics, type MetricAnswer } from '../ask';
import { backedValues, callerFor, realGateway, type GoldenStores } from './run';

const stores: GoldenStores = {
  A: { id: '00000000-0000-4000-8000-000000000031', code: 'brand-a' },
  B: { id: '00000000-0000-4000-8000-000000000032', code: 'brand-b' },
};
const C = '00000000-0000-4000-8000-0000000c0001';
const P = '00000000-0000-4000-8000-0000000d0001';
const BER = '00000000-0000-4000-8000-0000000000a1';
const TYO = '00000000-0000-4000-8000-0000000000a2';
const NOW = new Date('2026-11-19T09:00:00.000Z');
const W = { from: '2026-10-01', to: '2026-11-01', grain: 'total' };

/** The analytics store, by the model each statement reads (a totals statement has no dimension column). */
const reader: MetricsReader = {
  async query({ query }) {
    const has = (s: string) => query.includes(s);
    const rows = has('FROM raw_events')
      ? [{ t: '2026-11-19 00:00:00.000' }]
      : has('m_size')
        ? [{ out_cohort: '2026-03-01', m_size: '40' }]
        : has('out_offset')
          ? [
              { out_cohort: '2026-03-01', out_offset: 0, m_active: '40', m_net: '800000' },
              { out_cohort: '2026-03-01', out_offset: 1, m_active: '12', m_net: '300000' },
              { out_cohort: '2026-03-01', out_offset: 2, m_active: '3', m_net: '90000' },
            ]
          : has('fct_order_sales')
            ? has('out_store')
              ? [
                  { out_store: stores.A.id, m_customers: '200', m_repeat_customers: '46' },
                  { out_store: stores.B.id, m_customers: '150', m_repeat_customers: '21' },
                ]
              : [{ m_customers: '350', m_repeat_customers: '67' }]
            : has('fct_order_touch')
              ? [{ out_campaign: C, out_currency: 'EUR', m_campaign_net_sales_minor: '1250000' }]
              : has('dim_campaign')
                ? [{ out_campaign: C, out_currency: 'EUR', m_campaign_budget_minor: '500000' }]
                : has('fct_order_fulfilment')
                  ? has('out_warehouse')
                    ? [
                        { out_warehouse: BER, m_hours_to_ship_p50: 18.5 },
                        { out_warehouse: TYO, m_hours_to_ship_p50: 41 },
                      ]
                    : [{ m_hours_to_ship_p50: 26 }]
                  : has('fct_payment_event')
                    ? has('out_failure')
                      ? [
                          { out_failure: 'card_declined', m_payments_failed: '12' },
                          { out_failure: 'insufficient_funds', m_payments_failed: '7' },
                          { out_failure: 'other', m_payments_failed: '3' },
                        ]
                      : [{ m_payments_failed: '22' }]
                    : has('stg_cart_abandoned_v1')
                      ? [
                          {
                            out_currency: 'EUR',
                            m_abandoned_carts: '310',
                            m_abandoned_value_minor: '4650000',
                          },
                          {
                            out_currency: 'JPY',
                            m_abandoned_carts: '12',
                            m_abandoned_value_minor: '96000',
                          },
                        ]
                      : [];
    return { json: async <T>() => rows as T[] };
  },
};

type Parsed = {
  ref?: string;
  rows?: Record<string, unknown>[];
  currency_totals?: { currency: string | null; values: Record<string, number | null> }[];
  cohorts?: { cohort_month: string; size: number | null; cells: Record<string, unknown>[] }[];
  totals?: { kind: string; bucket: string; count: number }[];
};
const v = (r: Record<string, unknown>, m: string) => (r.values as Record<string, number | null>)[m];
const major = (minor: number) => (minor / 100).toFixed(2);
const pct = (bp: number) => (bp / 100).toFixed(2);

interface OwnerCase {
  question: string;
  tool: string;
  input: Record<string, unknown>;
  /** the scripted model's answer, written ONLY from what the tool returned (aliases, refs) */
  answer: (r: Parsed) => string;
  expected: string;
  caveat: RegExp;
  metrics?: MetricId[];
}

const CASES: OwnerCase[] = [
  {
    question: 'Are we keeping customers? How did last spring’s customers come back?',
    tool: 'customer_cohorts',
    input: { from_month: '2026-03', to_month: '2026-03', months: 3, currency: 'EUR' },
    answer: (r) => {
      const c = r.cohorts![0]!;
      const [m0, m1, m2] = c.cells as {
        active: number | null;
        retention_bp: number | null;
        ltv_to_date_minor: number | null;
      }[];
      return [
        `The ${c.cohort_month} cohort: ${c.size} new customers. A month later ${m1!.active} came back (${pct(m1!.retention_bp!)} %); net sales per customer to date ${major(m0!.ltv_to_date_minor!)} EUR, then ${major(m1!.ltv_to_date_minor!)} EUR [${r.ref}].`,
        m2!.active === null ? 'The third month has fewer than 5 customers, so it is withheld.' : '',
      ].join('\n');
    },
    expected:
      'The 2026-03 cohort: 40 new customers. A month later 12 came back (30.00 %); net sales per customer to date 200.00 EUR, then 275.00 EUR [k1].\nThe third month has fewer than 5 customers, so it is withheld.',
    caveat: /fewer than 5 customers/,
  },
  {
    question: 'What is our repeat rate per brand?',
    tool: 'query_metrics',
    input: {
      metrics: ['customers', 'repeat_customers', 'repeat_rate_bp'],
      dimensions: ['store'],
      ...W,
    },
    answer: (r) =>
      r
        .rows!.map(
          (x) =>
            `${String(x.store)}: ${pct(v(x, 'repeat_rate_bp')!)} % (${v(x, 'repeat_customers')} of ${v(x, 'customers')} customers came back) [${r.ref}]`,
        )
        .concat(
          'Customers are counted per brand: someone who buys from both brands counts in each.',
        )
        .join('\n'),
    expected:
      'brand-a: 23.00 % (46 of 200 customers came back) [q1]\nbrand-b: 14.00 % (21 of 150 customers came back) [q1]\nCustomers are counted per brand: someone who buys from both brands counts in each.',
    caveat: /per brand/,
    metrics: ['customers', 'repeat_customers', 'repeat_rate_bp'],
  },
  {
    question: 'Which campaign brought the most net sales, and did it beat its budget?',
    tool: 'query_metrics',
    input: {
      metrics: ['campaign_net_sales_minor', 'campaign_budget_minor'],
      dimensions: ['campaign'],
      ...W,
    },
    answer: (r) => {
      const x = r.rows![0]!;
      return `${String(x.campaign)} brought ${major(v(x, 'campaign_net_sales_minor')!)} EUR of net sales against a planned budget of ${major(v(x, 'campaign_budget_minor')!)} EUR [${r.ref}]. The budget is what was planned, not what was spent: ad spend is not recorded yet.`;
    },
    expected:
      'Autumn push brought 12500.00 EUR of net sales against a planned budget of 5000.00 EUR [q1]. The budget is what was planned, not what was spent: ad spend is not recorded yet.',
    caveat: /planned, not what was spent/,
    metrics: ['campaign_net_sales_minor', 'campaign_budget_minor'],
  },
  {
    question: 'How much discount did the spring promotion cost us?',
    tool: 'query_metrics',
    input: {
      metrics: ['promotion_orders', 'promotion_discount_minor'],
      dimensions: ['promotion'],
      ...W,
    },
    answer: (r) => {
      const x = r.rows![0]!;
      return `${String(x.promotion)}: ${major(v(x, 'promotion_discount_minor')!)} EUR of discount over ${v(x, 'promotion_orders')} orders [${r.ref}]. Free shipping is not counted as discount.`;
    },
    expected:
      'Spring sale: 1260.00 EUR of discount over 84 orders [q1]. Free shipping is not counted as discount.',
    caveat: /Free shipping is not counted/,
    metrics: ['promotion_orders', 'promotion_discount_minor'],
  },
  {
    question: 'How long do orders take to ship from Berlin vs Tokyo?',
    tool: 'query_metrics',
    input: { metrics: ['hours_to_ship_p50'], dimensions: ['warehouse'], ...W },
    answer: (r) =>
      r
        .rows!.map(
          (x) => `${String(x.warehouse)}: ${v(x, 'hours_to_ship_p50')} h (median) [${r.ref}]`,
        )
        .concat(
          `All warehouses: ${r.currency_totals![0]!.values.hours_to_ship_p50} h, the median over every order shipped in October.`,
        )
        .join('\n'),
    expected:
      'BER: 18.5 h (median) [q1]\nTYO: 41 h (median) [q1]\nAll warehouses: 26 h, the median over every order shipped in October.',
    caveat: /median over every order shipped/,
    metrics: ['hours_to_ship_p50'],
  },
  {
    question: 'What is stuck? Orders not shipped for more than 3 days?',
    tool: 'operations_backlog',
    input: {},
    answer: (r) => {
      const t = (kind: string, bucket: string) =>
        r.totals!.find((x) => x.kind === kind && x.bucket === bucket)?.count ?? 0;
      const w = r.rows!.find((x) => x.kind === 'shipment_not_shipped')!;
      return `Right now: ${t('unassigned', 'gt_7d')} paid orders have had no shipment for more than a week, and ${t('shipment_not_shipped', 'd3_7')} shipments in ${String(w.warehouse)} have waited between three days and a week [${r.ref}].`;
    },
    expected:
      'Right now: 3 paid orders have had no shipment for more than a week, and 5 shipments in BER have waited between three days and a week [b1].',
    caveat: /Right now/,
  },
  {
    question: 'Why are payments failing?',
    tool: 'query_metrics',
    input: { metrics: ['payments_failed'], dimensions: ['failure_reason'], ...W },
    answer: (r) =>
      r
        .rows!.map((x) => `${String(x.failure_reason)}: ${v(x, 'payments_failed')} [${r.ref}]`)
        .concat(
          'These are the PSP’s failure codes (other = no code); a payment that failed twice counts once.',
        )
        .join('\n'),
    expected:
      'card_declined: 12 [q1]\ninsufficient_funds: 7 [q1]\nother: 3 [q1]\nThese are the PSP’s failure codes (other = no code); a payment that failed twice counts once.',
    caveat: /failure codes/,
    metrics: ['payments_failed'],
  },
  {
    question: 'How many abandoned carts did we recover?',
    tool: 'query_metrics',
    input: { metrics: ['abandoned_carts', 'abandoned_value_minor'], ...W },
    answer: (r) =>
      r
        .currency_totals!.map(
          (t) =>
            `${t.values.abandoned_carts} carts abandoned in ${t.currency} (${major(t.values.abandoned_value_minor!)}) [${r.ref}]`,
        )
        .concat(
          'Recovered carts are counted only in the abandoned-cart report, over each store’s default-currency carts; I cannot divide one by the other.',
        )
        .join('\n'),
    expected:
      '310 carts abandoned in EUR (46500.00) [q1]\n12 carts abandoned in JPY (960.00) [q1]\nRecovered carts are counted only in the abandoned-cart report, over each store’s default-currency carts; I cannot divide one by the other.',
    caveat: /default-currency carts/,
    metrics: ['abandoned_carts', 'abandoned_value_minor'],
  },
];

/** What any answer to an owner question must pass (#935 e); [] when it does. */
export function checkOwnerAnswer(c: OwnerCase, a: MetricAnswer): string[] {
  const problems: string[] = [];
  if (!c.caveat.test(a.answer)) problems.push(`the caveat ${String(c.caveat)} is missing`);
  if (/\b(ch|cp|pr|[pcwigu])\d+\b/.test(a.answer)) problems.push('an alias is left in the answer');
  // every number is in the evidence the answer carries (#951 review 6: cohorts and the backlog too)
  const backed = new Set<string>();
  for (const q of a.queries)
    if (q.result && c.metrics) for (const x of backedValues(q.result, c.metrics)) backed.add(x);
  for (const k of a.cohorts ?? [])
    for (const co of k.result.cohorts) {
      for (const part of co.cohort_month.split('-')) backed.add(part);
      if (co.size !== null) backed.add(String(co.size));
      for (const cell of co.cells) {
        if (cell.active !== null) backed.add(String(cell.active));
        if (cell.retention_bp !== null) backed.add((cell.retention_bp / 100).toFixed(2));
        if (cell.ltv_to_date_minor !== null) backed.add((cell.ltv_to_date_minor / 100).toFixed(2));
      }
      backed.add(String(MIN_CUSTOMERS)); // the rule the answer states
    }
  for (const b of a.backlog ?? []) for (const x of b.result.totals) backed.add(String(x.count));
  const numbers = a.answer.replace(/\[[qkbh]\d+\]/g, '').match(/\d+(?:\.\d+)?/g) ?? [];
  for (const n of numbers) if (!backed.has(n)) problems.push(`${n} is in no result`);
  return problems;
}

async function ask(c: OwnerCase, finalText?: (s: string) => string) {
  const transport = createFakeTransport({
    script: [
      { toolUse: [{ name: c.tool, input: c.input }] },
      (req: AiRequest) => {
        const content = (req.turns ?? []).flatMap((t) =>
          t.role === 'user' ? t.toolResults : [],
        )[0]!.content;
        const text = c.answer(JSON.parse(content) as Parsed);
        return { text: finalText ? finalText(text) : text };
      },
    ],
  });
  const caller = callerFor('analyst', stores);
  const answer = await askMetrics(
    {
      reader,
      gatewayFor: realGateway(transport),
      biQaSwitches: async () => new Map(),
      now: () => NOW,
      labels: async () => ({
        campaign: { [C]: 'Autumn push' },
        promotion: { [P]: 'Spring sale' },
        warehouse: { [BER]: 'BER', [TYO]: 'TYO' },
      }),
      promotions: async () => [
        {
          out_promotion: P,
          out_currency: 'EUR',
          m_promotion_orders: '84',
          m_promotion_discount_minor: '126000',
        },
      ],
      cohorts: (ids, q) => getCustomerCohorts(reader, q, ids, NOW),
      backlog: async () => ({
        generated_at: NOW.toISOString(),
        buckets: ['lt_1d', 'd1_2', 'd3_7', 'gt_7d'],
        rows: [
          {
            kind: 'unassigned',
            store_id: stores.A.id,
            warehouse_id: null,
            bucket: 'gt_7d',
            count: 3,
          },
          {
            kind: 'shipment_not_shipped',
            store_id: stores.A.id,
            warehouse_id: BER,
            bucket: 'd3_7',
            count: 5,
          },
        ],
        totals: [
          { kind: 'unassigned', bucket: 'gt_7d', count: 3 },
          { kind: 'shipment_not_shipped', bucket: 'd3_7', count: 5 },
        ],
      }),
    },
    caller,
    { question: c.question },
  );
  return { answer, transport };
}

describe('the owner’s wave 2 questions (#935 e acceptance)', () => {
  it.each(CASES.map((c) => [c.question, c] as const))('%s', async (_q, c) => {
    const { answer, transport } = await ask(c);
    expect(answer.answer).toBe(c.expected);
    expect(checkOwnerAnswer(c, answer)).toEqual([]);
    // the model saw aliases only: no name, no uuid
    const sent = JSON.stringify(transport.calls);
    for (const secret of ['Autumn push', 'Spring sale', C, P, BER, TYO])
      expect(sent).not.toContain(secret);
  });

  it('the cohorts and backlog answers carry their evidence (k1, b1), and an invented figure there is caught', async () => {
    const cohorts = await ask(CASES[0]!);
    expect(cohorts.answer.cohorts!.map((k) => k.ref)).toEqual(['k1']);
    const backlog = await ask(CASES[5]!);
    expect(backlog.answer.backlog!.map((b) => b.ref)).toEqual(['b1']);
    const invented = await ask(CASES[5]!, (t) => t.replace('5 shipments', '6 shipments'));
    expect(checkOwnerAnswer(CASES[5]!, invented.answer)).toContain('6 is in no result');
  });

  it('the checks catch a dropped caveat, an invented figure and a left alias', async () => {
    const budget = CASES[2]!;
    const noCaveat = await ask(budget, (t) => t.replace(/ The budget is what.*$/, ''));
    expect(checkOwnerAnswer(budget, noCaveat.answer)).toContain(
      `the caveat ${String(budget.caveat)} is missing`,
    );
    const invented = await ask(budget, (t) => t.replace('12500.00', '13000.00'));
    expect(checkOwnerAnswer(budget, invented.answer)).toContain('13000.00 is in no result');
    const alias = await ask(budget, (t) => `${t} See also cp7.`);
    expect(checkOwnerAnswer(budget, alias.answer)).toContain('an alias is left in the answer');
  });
});
