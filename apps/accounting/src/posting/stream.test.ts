// A generated month over two legal entities and two currencies through the pure posting functions with an in-memory
// projection: the trial balance of every legal entity is zero per currency, every entry balances, every account of
// an event appears once, and the contract liability of a fully shipped order is exactly released.
import { describe, expect, it } from 'vitest';
import { ACCOUNT } from '../chart.js';
import { generateMonth, LE_A, LE_B } from './fixtures.js';
import { legalEntityIdOf, orderIdOf, postEvent } from './index.js';
import type { JournalEntry, OrderProjection } from './types.js';

function run(seed: number, orders: number) {
  const month = generateMonth({ orders, seed });
  const projections = new Map<string, OrderProjection>();
  const entries: JournalEntry[] = [];
  const perEntity = new Map<string, Map<string, number>>(); // legal entity → currency → Σ debit − Σ credit
  for (const e of month.events) {
    const r = postEvent(e, projections.get(orderIdOf(e)) ?? null);
    if (r.order) projections.set(r.order.order_id, r.order);
    for (const entry of r.entries) {
      entries.push(entry);
      expect(entry.legal_entity_id).toBe(legalEntityIdOf(e));
      const seen = new Set<string>();
      for (const l of entry.lines) {
        expect(seen.has(l.account_code)).toBe(false);
        seen.add(l.account_code);
        const m = perEntity.get(entry.legal_entity_id) ?? new Map<string, number>();
        m.set(l.currency, (m.get(l.currency) ?? 0) + l.debit_minor - l.credit_minor);
        perEntity.set(entry.legal_entity_id, m);
      }
    }
  }
  return { month, projections, entries, perEntity };
}

describe('a generated month', () => {
  it('1,200+ events over two legal entities: trial balance zero per legal entity per currency', () => {
    const { month, entries, perEntity, projections } = run(42, 400);
    expect(month.events.length).toBeGreaterThanOrEqual(1_200);
    expect(month.shipments).toBeGreaterThan(100);
    expect(month.refunds).toBeGreaterThan(30);
    expect(month.cancellations).toBeGreaterThan(20);
    expect([...perEntity.keys()].sort()).toEqual([LE_A, LE_B].sort());
    for (const [le, byCurrency] of perEntity) {
      for (const [currency, diff] of byCurrency) {
        expect(diff, `${le} ${currency}`).toBe(0);
      }
    }
    expect(perEntity.get(LE_A)!.has('EUR')).toBe(true);
    expect(perEntity.get(LE_B)!.has('GBP')).toBe(true);
    expect(entries.length).toBeGreaterThan(1_000);

    // every fully shipped order has released all of its goods; a cancelled order keeps what it actually released;
    // nothing is released twice
    for (const o of projections.values()) {
      const shippedAll = o.lines.every((l) => l.shipped_quantity === l.quantity);
      if (shippedAll) {
        expect(o.goods_released_minor, o.order_id).toBe(o.goods_net_minor);
        expect(o.shipping_released).toBe(true);
      } else {
        expect(o.goods_released_minor).toBeLessThanOrEqual(o.goods_net_minor);
      }
      expect(o.lines.reduce((a, l) => a + l.released_minor, 0)).toBe(o.goods_released_minor);
    }
    console.info(
      JSON.stringify({
        test: 'stream',
        events: month.events.length,
        orders: month.orders,
        shipments: month.shipments,
        captures: month.captures,
        refunds: month.refunds,
        cancellations: month.cancellations,
        entries: entries.length,
        lines: entries.reduce((a, e) => a + e.lines.length, 0),
      }),
    );
  });

  it('the same seed replays the same month; another seed balances too', () => {
    const a = run(7, 150);
    const b = run(7, 150);
    // ids are fresh uuids on every run; the amounts, dates, journals and accounts are the replayable part
    const shape = (entries: JournalEntry[]) =>
      entries.map(({ source_event_id: _s, reference_id: _r, ...rest }) => rest);
    expect(shape(a.entries)).toEqual(shape(b.entries));
    const c = run(2026, 250);
    for (const byCurrency of c.perEntity.values())
      for (const diff of byCurrency.values()) expect(diff).toBe(0);
  });

  it('contract liability of the whole month = Σ unreleased goods + unreleased shipping of open (not cancelled) orders', () => {
    const { entries, projections } = run(99, 200);
    const cl = new Map<string, number>();
    for (const e of entries)
      for (const l of e.lines)
        if (
          l.account_code === ACCOUNT.CONTRACT_LIABILITY_GOODS ||
          l.account_code === ACCOUNT.CONTRACT_LIABILITY_SHIPPING
        )
          cl.set(l.currency, (cl.get(l.currency) ?? 0) + l.credit_minor - l.debit_minor);
    const open = new Map<string, number>();
    for (const o of projections.values()) {
      if (o.status === 'cancelled') continue; // the cancel cleared its liability
      const unreleased =
        o.goods_net_minor -
        o.goods_released_minor +
        (o.shipping_released ? 0 : o.shipping_net_minor);
      open.set(o.currency, (open.get(o.currency) ?? 0) + unreleased);
    }
    expect(Object.fromEntries(cl)).toEqual(Object.fromEntries(open));
  });
});
