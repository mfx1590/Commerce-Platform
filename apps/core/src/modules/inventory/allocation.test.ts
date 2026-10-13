// The allocation seam (#454 / #456), pure part: the default policy and the validation of a policy's decision.
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import {
  currentAllocationPolicy,
  priorityGreedyPolicy,
  setAllocationPolicy,
  validateDecisions,
  type AllocationContext,
  type AllocationLine,
} from './allocation';

const ctx: AllocationContext = {
  organizationId: 'org',
  storeId: 'store-a',
  orderId: 'order-1',
  destinationCountry: 'NL',
  routingSettings: null,
};
const EU = { warehouseId: 'wh-eu', warehouseCode: 'wh-eu', country: 'NL', priority: 10 };
const US = { warehouseId: 'wh-us', warehouseCode: 'wh-us', country: 'US', priority: 20 };
const line = (
  variantId: string,
  quantity: number,
  eu: number,
  us: number,
  over: Partial<AllocationLine> = {},
): AllocationLine => ({
  variantId,
  stockItemId: `item-of-${variantId}`,
  quantity,
  allowBackorder: false,
  // deliberately NOT in priority order: the policy sorts, it does not trust the caller's order
  candidates: [
    { ...US, available: us },
    { ...EU, available: eu },
  ],
  ...over,
});

afterEach(() => {
  setAllocationPolicy(priorityGreedyPolicy);
});

describe('priorityGreedyPolicy (the default: today’s behaviour)', () => {
  it('fills from the priority warehouse first and splits only when it must', () => {
    expect(priorityGreedyPolicy(ctx, [line('v1', 3, 5, 5)])).toEqual([
      {
        variantId: 'v1',
        allocations: [{ warehouseId: 'wh-eu', quantity: 3, rule: 'priority' }],
        shortfall: 0,
      },
    ]);
    expect(priorityGreedyPolicy(ctx, [line('v1', 7, 5, 5)])).toEqual([
      {
        variantId: 'v1',
        allocations: [
          { warehouseId: 'wh-eu', quantity: 5, rule: 'priority' },
          { warehouseId: 'wh-us', quantity: 2, rule: 'split:priority' },
        ],
        shortfall: 0,
      },
    ]);
  });

  it('skips a warehouse with nothing (or a negative balance) and reports what nobody could cover', () => {
    expect(priorityGreedyPolicy(ctx, [line('v1', 4, -2, 3)])).toEqual([
      {
        variantId: 'v1',
        allocations: [{ warehouseId: 'wh-us', quantity: 3, rule: 'priority' }],
        shortfall: 1,
      },
    ]);
    expect(priorityGreedyPolicy(ctx, [line('v1', 2, 0, 0)])).toEqual([
      { variantId: 'v1', allocations: [], shortfall: 2 },
    ]);
  });

  it('two lines mapping ONE stock item draw from one balance: a unit is never promised twice', () => {
    const shared = { stockItemId: 'shared-item' };
    const decisions = priorityGreedyPolicy(ctx, [
      line('v-brand-a', 4, 5, 2, shared),
      line('v-brand-b', 4, 5, 2, shared),
    ]);
    expect(decisions).toEqual([
      {
        variantId: 'v-brand-a',
        allocations: [{ warehouseId: 'wh-eu', quantity: 4, rule: 'priority' }],
        shortfall: 0,
      },
      {
        variantId: 'v-brand-b',
        allocations: [
          { warehouseId: 'wh-eu', quantity: 1, rule: 'priority' },
          { warehouseId: 'wh-us', quantity: 2, rule: 'split:priority' },
        ],
        shortfall: 1,
      },
    ]);
    expect(() =>
      validateDecisions(
        [line('v-brand-a', 4, 5, 2, shared), line('v-brand-b', 4, 5, 2, shared)],
        decisions,
      ),
    ).not.toThrow();
  });

  it('is pure: the same input gives the same output and the input is not mutated', () => {
    const lines = [line('v1', 7, 5, 5)];
    const snapshot = JSON.stringify(lines);
    expect(priorityGreedyPolicy(ctx, lines)).toEqual(priorityGreedyPolicy(ctx, lines));
    expect(JSON.stringify(lines)).toBe(snapshot);
  });
});

describe('setAllocationPolicy', () => {
  it('replaces the policy and returns the previous one', () => {
    const mine = () => [];
    expect(currentAllocationPolicy()).toBe(priorityGreedyPolicy);
    expect(setAllocationPolicy(mine)).toBe(priorityGreedyPolicy);
    expect(currentAllocationPolicy()).toBe(mine);
    expect(setAllocationPolicy(priorityGreedyPolicy)).toBe(mine);
  });
});

describe('validateDecisions: a bad decision is a bug (500 internal), never a customer error', () => {
  const lines = [line('v1', 4, 3, 5)];
  const rejects = (decisions: unknown, fragment: string) => {
    let caught: unknown;
    try {
      validateDecisions(lines, decisions as never);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('internal');
    expect((caught as AppError).status).toBe(500);
    expect((caught as AppError).message).toContain(fragment);
  };

  it('accepts an honest decision and returns it in line order', () => {
    const two = [line('v1', 2, 3, 5), line('v2', 1, 1, 0)];
    const d2 = {
      variantId: 'v2',
      allocations: [{ warehouseId: 'wh-eu', quantity: 1, rule: 'x' }],
      shortfall: 0,
    };
    const d1 = {
      variantId: 'v1',
      allocations: [{ warehouseId: 'wh-us', quantity: 2, rule: 'y' }],
      shortfall: 0,
    };
    expect(validateDecisions(two, [d2, d1])).toEqual([d1, d2]);
  });

  it('an over-allocation (more than the locked row has available)', () => {
    rejects(
      [
        {
          variantId: 'v1',
          allocations: [{ warehouseId: 'wh-eu', quantity: 4, rule: 'r' }],
          shortfall: 0,
        },
      ],
      'more than the warehouse has available',
    );
  });

  it('a warehouse that was not offered', () => {
    rejects(
      [
        {
          variantId: 'v1',
          allocations: [{ warehouseId: 'wh-asia', quantity: 4, rule: 'r' }],
          shortfall: 0,
        },
      ],
      'not offered',
    );
  });

  it('allocations and shortfall that do not add up, a missing or doubled decision, bad quantities, a missing rule', () => {
    rejects(
      [
        {
          variantId: 'v1',
          allocations: [{ warehouseId: 'wh-eu', quantity: 3, rule: 'r' }],
          shortfall: 0,
        },
      ],
      'add up',
    );
    rejects([], 'one decision per line');
    rejects([{ variantId: 'other', allocations: [], shortfall: 4 }], 'no decision for a line');
    rejects(
      [
        {
          variantId: 'v1',
          allocations: [{ warehouseId: 'wh-eu', quantity: 0, rule: 'r' }],
          shortfall: 4,
        },
      ],
      'positive integers',
    );
    rejects(
      [
        {
          variantId: 'v1',
          allocations: [{ warehouseId: 'wh-eu', quantity: 1.5, rule: 'r' }],
          shortfall: 2.5,
        },
      ],
      'positive integers',
    );
    rejects(
      [
        {
          variantId: 'v1',
          allocations: [{ warehouseId: 'wh-eu', quantity: 1, rule: '' }],
          shortfall: 3,
        },
      ],
      'names its rule',
    );
    rejects(
      [
        {
          variantId: 'v1',
          allocations: [
            { warehouseId: 'wh-eu', quantity: 1, rule: 'r' },
            { warehouseId: 'wh-eu', quantity: 1, rule: 'r' },
          ],
          shortfall: 2,
        },
      ],
      'two allocations on one warehouse',
    );
  });

  it('sums per (stock item, warehouse) ACROSS lines: two lines of one item cannot each take the same units', () => {
    const shared = { stockItemId: 'shared-item' };
    const both = [line('v-a', 3, 4, 0, shared), line('v-b', 3, 4, 0, shared)];
    let caught: unknown;
    try {
      validateDecisions(both, [
        {
          variantId: 'v-a',
          allocations: [{ warehouseId: 'wh-eu', quantity: 3, rule: 'r' }],
          shortfall: 0,
        },
        {
          variantId: 'v-b',
          allocations: [{ warehouseId: 'wh-eu', quantity: 3, rule: 'r' }],
          shortfall: 0,
        },
      ]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: 'internal', details: { available: 4, allocated: 6 } });
  });
});
