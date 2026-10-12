// The allocation policy as a pure function (#435 part B): every routing rule in order, one warehouse when one
// covers the line, a split when none does, never more than available (property-style over seeded random stock),
// the same decision for the same input, and the rule recorded per allocation.
import { describe, expect, it } from 'vitest';
import { rankWarehouses, stockAwareAllocationPolicy } from './index';
import type { AllocationCandidate, AllocationContext, AllocationLine } from './index';

const EU = 'wh-eu-id';
const US = 'wh-us-id';
const UK = 'wh-uk-id';

const warehouse = (
  warehouseId: string,
  warehouseCode: string,
  country: string,
  priority: number,
  available: number,
): AllocationCandidate => ({ warehouseId, warehouseCode, country, priority, available });

const eu = (available: number) => warehouse(EU, 'wh-eu', 'NL', 10, available);
const us = (available: number) => warehouse(US, 'wh-us', 'US', 20, available);
const uk = (available: number) => warehouse(UK, 'wh-uk', 'GB', 30, available);

const context = (
  destinationCountry: string | null,
  routingSettings: unknown = {},
): AllocationContext => ({
  organizationId: 'org',
  storeId: 'store',
  orderId: 'order',
  destinationCountry,
  routingSettings,
});

const line = (
  quantity: number,
  candidates: AllocationCandidate[],
  stockItemId = 'item-one',
  variantId = 'variant-one',
): AllocationLine => ({ variantId, stockItemId, quantity, allowBackorder: false, candidates });

const decide = (ctx: AllocationContext, ...lines: AllocationLine[]) =>
  stockAwareAllocationPolicy(ctx, lines);

describe('ranking: the routing rules in order', () => {
  const all = [us(5), uk(5), eu(5)];
  const order = (ctx: AllocationContext) =>
    rankWarehouses(ctx, all).map((r) => `${r.candidate.warehouseCode}:${r.rule}`);

  it('1. the store override for the destination country comes first', () => {
    expect(order(context('DE', { countries: { DE: 'wh-us' } }))).toEqual([
      'wh-us:store_country',
      'wh-eu:same_region',
      'wh-uk:same_region',
    ]);
  });

  it('2. then the store default', () => {
    expect(order(context('DE', { countries: { FR: 'wh-us' }, default: 'wh-uk' }))).toEqual([
      'wh-uk:store_default',
      'wh-eu:same_region',
      'wh-us:priority',
    ]);
  });

  it('3. then a warehouse in the destination country, 4. then its region, 5. then priority', () => {
    expect(order(context('GB'))).toEqual([
      'wh-uk:same_country',
      'wh-eu:same_region',
      'wh-us:priority',
    ]);
    expect(order(context('CA'))).toEqual(['wh-us:same_region', 'wh-eu:priority', 'wh-uk:priority']);
    expect(order(context('JP'))).toEqual(['wh-eu:priority', 'wh-us:priority', 'wh-uk:priority']);
  });

  it('falls back to priority, then code, when the order has no destination', () => {
    expect(order(context(null))).toEqual(['wh-eu:priority', 'wh-us:priority', 'wh-uk:priority']);
    const tie = [warehouse('b-id', 'wh-b', 'NL', 10, 1), warehouse('a-id', 'wh-a', 'NL', 10, 1)];
    expect(rankWarehouses(context(null), tie).map((r) => r.candidate.warehouseCode)).toEqual([
      'wh-a',
      'wh-b',
    ]);
  });

  it('ignores malformed settings and a code that names no candidate', () => {
    for (const settings of [
      null,
      'x',
      [],
      { countries: 'nope', default: 7 },
      { default: 'wh-gone' },
    ]) {
      expect(order(context('NL', settings))[0]).toBe('wh-eu:same_country');
    }
  });

  it('is case-insensitive about the destination country', () => {
    expect(order(context('gb'))[0]).toBe('wh-uk:same_country');
  });
});

describe('one line', () => {
  it('goes to one warehouse when the first ranked one covers it', () => {
    expect(decide(context('NL'), line(3, [us(10), eu(3)]))).toEqual([
      {
        variantId: 'variant-one',
        allocations: [{ warehouseId: EU, quantity: 3, rule: 'same_country' }],
        shortfall: 0,
      },
    ]);
  });

  it('prefers one farther warehouse that covers the line over splitting the nearest', () => {
    const [d] = decide(context('NL'), line(4, [eu(3), us(9)]));
    expect(d!.allocations).toEqual([{ warehouseId: US, quantity: 4, rule: 'priority' }]);
  });

  it('splits across two warehouses when neither covers the line, nearest first', () => {
    const [d] = decide(context('NL'), line(5, [us(4), eu(3)]));
    expect(d).toEqual({
      variantId: 'variant-one',
      allocations: [
        { warehouseId: EU, quantity: 3, rule: 'same_country' },
        { warehouseId: US, quantity: 2, rule: 'split:priority' },
      ],
      shortfall: 0,
    });
  });

  it('reports what no warehouse could cover as shortfall', () => {
    const [d] = decide(context('NL'), line(9, [eu(3), us(4)]));
    expect(d!.allocations.map((a) => a.quantity)).toEqual([3, 4]);
    expect(d!.shortfall).toBe(2);
  });

  it('skips empty and negative shelves', () => {
    const [d] = decide(context('NL'), line(2, [eu(0), uk(-4), us(1)]));
    expect(d).toEqual({
      variantId: 'variant-one',
      allocations: [{ warehouseId: US, quantity: 1, rule: 'priority' }],
      shortfall: 1,
    });
  });

  it('honours the store override even when another warehouse is nearer', () => {
    const [d] = decide(context('NL', { countries: { NL: 'wh-us' } }), line(2, [eu(9), us(9)]));
    expect(d!.allocations).toEqual([{ warehouseId: US, quantity: 2, rule: 'store_country' }]);
  });

  it('leaves the override for the next warehouse when the override cannot cover the line', () => {
    const [d] = decide(context('NL', { default: 'wh-us' }), line(3, [eu(9), us(1)]));
    expect(d!.allocations).toEqual([{ warehouseId: EU, quantity: 3, rule: 'same_country' }]);
  });

  it('answers a zero quantity and no candidates without inventing stock', () => {
    expect(decide(context('NL'), line(0, [eu(5)]))[0]).toMatchObject({
      allocations: [],
      shortfall: 0,
    });
    expect(decide(context('NL'), line(2, []))[0]).toMatchObject({ allocations: [], shortfall: 2 });
  });

  it('refuses a quantity that is not a non-negative integer', () => {
    expect(() => decide(context('NL'), line(1.5, [eu(5)]))).toThrow(RangeError);
    expect(() => decide(context('NL'), line(-1, [eu(5)]))).toThrow(RangeError);
  });
});

describe('several lines', () => {
  it('answers one decision per line, in the order of the lines', () => {
    const decisions = decide(
      context('NL'),
      line(1, [eu(5)], 'item-one', 'variant-one'),
      line(1, [eu(5)], 'item-two', 'variant-two'),
    );
    expect(decisions.map((d) => d.variantId)).toEqual(['variant-one', 'variant-two']);
  });

  it('does not spend the same unit twice when two lines map to one stock item', () => {
    const decisions = decide(
      context('NL'),
      line(2, [eu(3), us(1)], 'item-shared', 'variant-a'),
      line(2, [eu(3), us(1)], 'item-shared', 'variant-b'),
    );
    expect(decisions[0]!.allocations).toEqual([
      { warehouseId: EU, quantity: 2, rule: 'same_country' },
    ]);
    expect(decisions[1]!.allocations).toEqual([
      { warehouseId: EU, quantity: 1, rule: 'same_country' },
      { warehouseId: US, quantity: 1, rule: 'split:priority' },
    ]);
  });

  it('keeps separate stock items separate', () => {
    const decisions = decide(
      context('NL'),
      line(3, [eu(3)], 'item-one', 'variant-one'),
      line(3, [eu(3)], 'item-two', 'variant-two'),
    );
    expect(decisions.map((d) => d.shortfall)).toEqual([0, 0]);
  });
});

// A small seeded generator (mulberry32): random, and the same on every run and every machine.
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCase(seed: number): { ctx: AllocationContext; lines: AllocationLine[] } {
  const random = generator(seed);
  const int = (max: number) => Math.floor(random() * (max + 1));
  const pick = <T>(values: readonly T[]): T => values[int(values.length - 1)]!;
  const countries = ['NL', 'DE', 'GB', 'US', 'CA', 'JP'] as const;
  const warehouses = Array.from({ length: 1 + int(4) }, (_, i) => ({
    warehouseId: `wh-id-${i}`,
    warehouseCode: `wh-${i}`,
    country: pick(countries),
    priority: 10 * int(3),
  }));
  const items = ['item-a', 'item-b', 'item-c'];
  // One shelf per (item, warehouse), shared by every line of the order that maps to the item.
  const shelves = new Map<string, number>();
  for (const item of items) {
    for (const w of warehouses) shelves.set(`${item}:${w.warehouseId}`, int(12) - 2);
  }
  const lines = Array.from({ length: 1 + int(5) }, (_, i) => {
    const stockItemId = pick(items);
    return {
      variantId: `variant-${i}`,
      stockItemId,
      quantity: int(15),
      allowBackorder: random() < 0.3,
      candidates: warehouses.map((w) => ({
        ...w,
        available: shelves.get(`${stockItemId}:${w.warehouseId}`)!,
      })),
    };
  });
  const settings = pick([
    {},
    { default: pick(warehouses).warehouseCode },
    { countries: { [pick(countries)]: pick(warehouses).warehouseCode } },
  ]);
  return { ctx: context(pick([...countries, null]), settings), lines };
}

describe('properties over random stock levels (500 seeded cases)', () => {
  const cases = Array.from({ length: 500 }, (_, i) => randomCase(i + 1));

  it('never allocates more than a shelf holds, across all lines of the order', () => {
    for (const { ctx, lines } of cases) {
      const spent = new Map<string, number>();
      const decisions = stockAwareAllocationPolicy(ctx, lines);
      decisions.forEach((d, i) => {
        for (const a of d.allocations) {
          const key = `${lines[i]!.stockItemId}:${a.warehouseId}`;
          spent.set(key, (spent.get(key) ?? 0) + a.quantity);
        }
      });
      for (const l of lines) {
        for (const c of l.candidates) {
          const key = `${l.stockItemId}:${c.warehouseId}`;
          expect(spent.get(key) ?? 0).toBeLessThanOrEqual(Math.max(0, c.available));
        }
      }
    }
  });

  it('accounts for every unit: allocations + shortfall = quantity, positive, one entry per warehouse', () => {
    for (const { ctx, lines } of cases) {
      stockAwareAllocationPolicy(ctx, lines).forEach((d, i) => {
        const sum = d.allocations.reduce((n, a) => n + a.quantity, 0);
        expect(sum + d.shortfall).toBe(lines[i]!.quantity);
        expect(d.shortfall).toBeGreaterThanOrEqual(0);
        expect(d.allocations.every((a) => a.quantity > 0)).toBe(true);
        expect(new Set(d.allocations.map((a) => a.warehouseId)).size).toBe(d.allocations.length);
      });
    }
  });

  it('leaves a shortfall only when every shelf of the item is empty afterwards', () => {
    for (const { ctx, lines } of cases) {
      const decisions = stockAwareAllocationPolicy(ctx, lines);
      const spent = new Map<string, number>();
      decisions.forEach((d, i) => {
        for (const a of d.allocations) {
          const key = `${lines[i]!.stockItemId}:${a.warehouseId}`;
          spent.set(key, (spent.get(key) ?? 0) + a.quantity);
        }
      });
      decisions.forEach((d, i) => {
        if (d.shortfall === 0) return;
        for (const c of lines[i]!.candidates) {
          const key = `${lines[i]!.stockItemId}:${c.warehouseId}`;
          expect(Math.max(0, c.available) - (spent.get(key) ?? 0)).toBe(0);
        }
      });
    }
  });

  it('marks only the second and later allocations of a line as a split', () => {
    for (const { ctx, lines } of cases) {
      for (const d of stockAwareAllocationPolicy(ctx, lines)) {
        d.allocations.forEach((a, i) => expect(a.rule.startsWith('split:')).toBe(i > 0));
      }
    }
  });

  it('is deterministic: the same input twice, and with the candidates shuffled', () => {
    for (const { ctx, lines } of cases) {
      const first = stockAwareAllocationPolicy(ctx, lines);
      expect(stockAwareAllocationPolicy(ctx, lines)).toEqual(first);
      const reversed = lines.map((l) => ({ ...l, candidates: [...l.candidates].reverse() }));
      expect(stockAwareAllocationPolicy(ctx, reversed)).toEqual(first);
    }
  });

  it('does not modify its input', () => {
    const { ctx, lines } = randomCase(7);
    const before = JSON.stringify({ ctx, lines });
    stockAwareAllocationPolicy(ctx, lines);
    expect(JSON.stringify({ ctx, lines })).toBe(before);
  });
});
