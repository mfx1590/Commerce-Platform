import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AdminComponents } from '@/lib/api/admin-client';
import {
  ORDER_PII_KEYS,
  forActions,
  forFulfilment,
  forLines,
  type OrderForActions,
  type OrderForFulfilment,
  type OrderForLines,
} from '@/lib/orders/projection';
import { order } from './fixtures/orders';

type Order = AdminComponents['Order'];

/**
 * The #263 review finding, pinned: a client panel's props are serialised wholesale into the
 * Flight payload, so what the page hands each panel must contain no customer PII — by
 * construction (explicit key picks) and by type (the full `Order` is not assignable).
 */
describe('order projections for client components', () => {
  const full = order();
  const projections = {
    actions: forActions(full),
    lines: forLines(full),
    fulfilment: forFulfilment(full),
  };

  it('each projection carries exactly the keys its panel reads', () => {
    expect(Object.keys(projections.actions).sort()).toEqual(
      ['currency', 'display_id', 'id', 'items', 'payments', 'refunds', 'status'].sort(),
    );
    expect(Object.keys(projections.lines).sort()).toEqual(['id', 'items']);
    expect(Object.keys(projections.fulfilment).sort()).toEqual(
      ['id', 'items', 'returns', 'shipments'].sort(),
    );
  });

  it('no projection carries an email, a customer id, an address or metadata — as keys or as values', () => {
    for (const projection of Object.values(projections)) {
      for (const key of ORDER_PII_KEYS) expect(projection).not.toHaveProperty(key);
      // What actually crosses the wire is the JSON; check it for the fixture's PII values too.
      const wire = JSON.stringify(projection);
      expect(wire).not.toContain(full.email);
      expect(wire).not.toContain(full.shipping_address.line1);
      expect(wire).not.toContain(full.shipping_address.last_name);
      expect(wire).not.toContain(full.customer_id ?? 'never');
    }
  });

  it('the full Order does not typecheck as a panel prop; only the projection functions produce one', () => {
    expectTypeOf<Order>().not.toMatchTypeOf<OrderForActions>();
    expectTypeOf<Order>().not.toMatchTypeOf<OrderForLines>();
    expectTypeOf<Order>().not.toMatchTypeOf<OrderForFulfilment>();
    expectTypeOf(forActions(full)).toMatchTypeOf<OrderForActions>();
  });
});
