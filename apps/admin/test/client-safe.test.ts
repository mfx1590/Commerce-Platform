import { describe, expect, it } from 'vitest';
import { makeProjection, markClientSafe } from '@/lib/client-safe';
import { order } from './fixtures/orders';

/**
 * `markClientSafe` is the escape hatch for computed projections, narrowed after the #268
 * re-review: it accepts hand-built objects of scalars, and refuses — at compile time — a PII
 * record or anything holding one. The `@ts-expect-error` lines are the test: `pnpm typecheck`
 * fails if any of them starts compiling.
 */
describe('markClientSafe', () => {
  const full = order();

  it('brands a computed object of scalars', () => {
    const summary = markClientSafe({ label: 'Order #1003', lines: 2, channels: ['email'] });
    expect(summary).toEqual({ label: 'Order #1003', lines: 2, channels: ['email'] });
  });

  it('refuses a record, a field holding one, and a list of them (compile time)', () => {
    // @ts-expect-error — an Order is a PII record; use makeProjection with named keys.
    markClientSafe(full);
    // @ts-expect-error — a field holding the record ships it whole.
    markClientSafe({ label: 'x', order: full });
    // @ts-expect-error — so does a list of them.
    markClientSafe({ rows: [full] });
    // @ts-expect-error — and a nested address.
    markClientSafe({ to: full.shipping_address });
    expect(true).toBe(true);
  });

  it('leaves makeProjection as the way to take fields from a record', () => {
    const picked = makeProjection(full, ['id', 'status']);
    expect(Object.keys(picked).sort()).toEqual(['id', 'status']);
  });
});
