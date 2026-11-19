// #871's acceptance test: the owner's question "How is our availability, do we need to order anything?" through
// askMetrics on the REAL AI gateway (fake transport, scripted model), the inventory_health tool over a deterministic
// stock fixture, and the server-side alias substitution. The expected answer is CONCRETE: which items, their cover,
// the quantity to order, the parameters, and the sentence that incoming is not tracked.
import { createFakeTransport, type AiRequest } from '@platform/ai';
import { describe, expect, it } from 'vitest';
import type { MetricsReader } from '../../metrics/execute';
import { computeInventoryHealth, type InventoryQuery } from '../../metrics/inventory';
import { askMetrics, type MetricAnswer } from '../ask';
import { callerFor, realGateway, type GoldenStores } from './run';
import {
  checkStockAnswer,
  EXPECTED_STOCK_ROWS,
  STOCK_NOW,
  STOCK_QUESTION,
  stockAnswerFrom,
  stockFixture,
} from './stock';

const stores: GoldenStores = {
  A: { id: '00000000-0000-4000-8000-000000000031', code: 'brand-a' },
  B: { id: '00000000-0000-4000-8000-000000000032', code: 'brand-b' },
};
const noReader: MetricsReader = {
  query: () => Promise.reject(new Error('the stock question reads no metrics series')),
};
const ASK = { status: ['stock_out', 'low', 'reorder'] };

async function ask(principal: 'analyst' | 'storeAdminA', finalText?: (content: string) => string) {
  const transport = createFakeTransport({
    script: [
      { toolUse: [{ name: 'inventory_health', input: ASK }] },
      (req: AiRequest) => {
        const content = (req.turns ?? []).flatMap((t) =>
          t.role === 'user' ? t.toolResults : [],
        )[0]!.content;
        return { text: (finalText ?? stockAnswerFrom)(content) };
      },
    ],
  });
  const caller = callerFor(principal, stores);
  const answer: MetricAnswer = await askMetrics(
    {
      reader: noReader,
      gatewayFor: realGateway(transport),
      biQaSwitches: async () => new Map(),
      now: () => STOCK_NOW,
      inventory: async (ids, q: InventoryQuery) =>
        computeInventoryHealth(stockFixture(stores.A.id, stores.B.id), q, {
          organization: caller.organizationScope && ids.length > 1,
          now: STOCK_NOW,
        }),
      labels: async () => ({}),
    },
    caller,
    {
      question: STOCK_QUESTION,
      ...(principal === 'storeAdminA' ? { store_ids: [stores.A.id] } : {}),
    },
  );
  return { answer, transport };
}

describe('the owner’s stock question (#871 acceptance)', () => {
  it('names the items to order, with their cover and quantities, the parameters, and that incoming is not tracked', async () => {
    const { answer, transport } = await ask('analyst');
    // the tool offered and called, its result recorded in the answer (ref h1)
    expect(transport.calls[0]!.tools!.map((t) => t.name)).toEqual([
      'query_metrics',
      'movers',
      'inventory_health',
    ]);
    const result = answer.inventory![0]!.result!;
    expect(answer.inventory![0]!.ref).toBe('h1');
    expect(
      result.rows.map((r) => ({
        name: r.name,
        sku: r.sku,
        status: r.status,
        available: r.available,
        days_of_cover: r.days_of_cover,
        suggested_reorder_units: r.suggested_reorder_units,
      })),
    ).toEqual(EXPECTED_STOCK_ROWS);
    expect(result.incoming_tracked).toBe(false);
    // the answer the owner reads: names, not aliases (the model only ever saw i1, i2 …)
    expect(answer.answer).toBe(
      [
        'Yes, 3 items need ordering.',
        'Red mug (MUG-2): stock_out, -3 available, 0 days of cover; order 3 (sales were limited by stock, so real demand is likely higher) [h1]',
        'Blue mug (MUG-1): low, 20 available, 10 days of cover; order 64 [h1]',
        'Espresso cup (MUG-5): reorder, 30 available, 30 days of cover; order 12 (sales were limited by stock, so real demand is likely higher) [h1]',
        'Based on sales over the last 28 days, a lead time of 14 days and 28 days of cover.',
        'Incoming stock is not tracked yet: the suggestions assume nothing is on order, so subtract what you have already ordered from suppliers.',
      ].join('\n'),
    );
    expect(answer.labels).toMatchObject({
      i1: 'Red mug (MUG-2)',
      i2: 'Blue mug (MUG-1)',
      i3: 'Espresso cup (MUG-5)',
    });
    // no title ever went to the model
    expect(JSON.stringify(transport.calls)).not.toContain('Blue mug');
    expect(checkStockAnswer(answer)).toEqual([]);
  });

  it('the checks catch an answer that drops the incoming sentence, a quantity, or invents a figure', async () => {
    const dropIncoming = await ask('analyst', (c) =>
      stockAnswerFrom(c)
        .split('\n')
        .filter((l) => !l.startsWith('Incoming'))
        .join('\n'),
    );
    expect(checkStockAnswer(dropIncoming.answer)).toContain(
      'the "incoming is not tracked" sentence is missing',
    );
    const wrongQty = await ask('analyst', (c) =>
      stockAnswerFrom(c).replace('order 64', 'order 70'),
    );
    expect(checkStockAnswer(wrongQty.answer)).toEqual(
      expect.arrayContaining([
        'Blue mug: its suggested quantity (64) is not stated',
        '70 is in no inventory result',
      ]),
    );
    const leftAlias = await ask('analyst', (c) => `${stockAnswerFrom(c)}\nAlso check i9.`);
    expect(checkStockAnswer(leftAlias.answer)).toContain('an alias is left in the answer');
  });

  it('a store admin asks the same: its own items, a shared item flagged and its suggestion partial', async () => {
    const { answer } = await ask('storeAdminA');
    const blue = answer.inventory![0]!.result!.rows.find((r) => r.sku === 'MUG-1')!;
    expect(blue).toMatchObject({ suggestion_partial: false }); // the fixture's shared set is empty for this caller
    expect(checkStockAnswer(answer)).toEqual([]);
  });
});
