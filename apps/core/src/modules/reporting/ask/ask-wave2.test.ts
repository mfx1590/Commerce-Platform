// BI v2 wave 2 (#935 e): a tool's filters may name an alias THIS question issued (the #924 gap "aliases are
// output-only"); anything else is a tool error, never a guess. utm values reach the model only as aliases; the
// cohorts and backlog tools are closed (no store ids: the question's stores) and name warehouses by alias.
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../lib/errors';
import { Aliases, BACKLOG_TOOL, biQaToolHandler, COHORTS_TOOL, resolveAliasInputs } from './tool';

const P = '00000000-0000-4000-8000-0000000000a1';
const W = '00000000-0000-4000-8000-0000000000b1';
const S = '00000000-0000-4000-8000-0000000000c1';

describe('alias inputs (#935 e)', () => {
  it('an alias this question issued maps back to its id; a uuid passes; anything else is a 400', () => {
    const a = new Aliases();
    const p = a.of('product', P)!;
    const u = a.of('utm', 'google')!;
    const input = {
      metrics: ['units'],
      filters: { product_ids: [p], utm_sources: [u], category_ids: [P] },
    };
    expect(resolveAliasInputs(input, a)).toEqual({
      metrics: ['units'],
      filters: { product_ids: [P], utm_sources: ['google'], category_ids: [P] },
    });
    for (const bad of [{ product_ids: ['p9'] }, { category_ids: [p] }, { warehouse_ids: ['w1'] }]) {
      let err: unknown;
      try {
        resolveAliasInputs({ filters: bad }, a);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).details).toMatchObject({ reason: 'alias_unknown' });
    }
  });
});

describe('cohorts and backlog tools', () => {
  const base = {
    reader: {} as never,
    caller: { stores: [S], finance: async () => false },
    executed: [],
  };

  it('the backlog tool names stores by code and warehouses by alias; no uuid reaches the model', async () => {
    const handle = biQaToolHandler({
      ...base,
      codes: new Map([[S, 'brand-a']]),
      backlog: async () => ({
        generated_at: 'now',
        buckets: ['lt_1d', 'd1_2', 'd3_7', 'gt_7d'],
        rows: [
          { kind: 'shipment_not_shipped', store_id: S, warehouse_id: W, bucket: 'd3_7', count: 4 },
        ],
        totals: [{ kind: 'shipment_not_shipped', bucket: 'd3_7', count: 4 }],
      }),
    });
    const r = await handle({ id: 't1', name: BACKLOG_TOOL, input: {} });
    expect(r.content).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(JSON.parse(r.content).rows).toEqual([
      { kind: 'shipment_not_shipped', store: 'brand-a', warehouse: 'w1', bucket: 'd3_7', count: 4 },
    ]);
  });

  it('cohorts: a bad month is a tool error the model can read; without the operation the tool says so', async () => {
    const handle = biQaToolHandler({
      ...base,
      cohorts: async (q) => ({ query: q, generated_at: 'now', currency: q.currency, cohorts: [] }),
    });
    const bad = await handle({
      id: 't',
      name: COHORTS_TOOL,
      input: { from_month: '2026-13', to_month: '2026-01', currency: 'EUR' },
    });
    expect(bad.isError).toBe(true);
    const ok = await handle({
      id: 't',
      name: COHORTS_TOOL,
      input: { from_month: '2026-01', to_month: '2026-03', currency: 'EUR' },
    });
    expect(JSON.parse(ok.content)).toEqual({ currency: 'EUR', cohorts: [] });
    const none = await biQaToolHandler(base)({ id: 't', name: COHORTS_TOOL, input: {} });
    expect(none.isError).toBe(true);
  });
});
