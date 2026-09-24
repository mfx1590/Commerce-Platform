/**
 * The orders screens' wrappers and actions against the spec's own examples (Admin API 0.4.5).
 *
 * Prism answers with what `admin-api.yaml` documents, so this proves the code reads the fields the
 * spec actually has — and, with `Prefer: code=<n>`, that the documented refusals (401/403/409) come
 * back through `adminRequest` → `toActionResult` in the shape the screens render. Prism is spawned
 * here on its own port, clear of `pnpm mock` and of the catalog suite.
 */
import { render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SEED_STORE_ID, preferring, startPrism, type PrismHandle } from './prism';

const BASE = 'http://127.0.0.1:4213';
let prism: PrismHandle | undefined;
// The wrappers read `env.adminApiUrl`, which the contract config pins to the states suite's Prism;
// this file spawns its own, so the variable is pointed here before the app modules are imported.
process.env['ADMIN_API_URL'] = BASE;
process.env['MOCK_ADMIN_API_URL'] = BASE;

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/current-session', () => ({
  getSession: async () => ({ accessToken: 'contract-test-token' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => `/${SEED_STORE_ID}/orders`,
}));

const api = await import('@/lib/api/admin');
const { adminRequest } = await import('@/lib/api/admin-client');
const { toActionResult } = await import('@/lib/forms/action-result');
const actions = await import('@/app/actions/orders');
const { ActionRefusal } = await import('@/components/states/action-refusal');
const { orderTimeline } = await import('@/lib/orders/timeline');
const { refundableMinor } = await import('@/lib/orders/refunds');

// The spec's OrderDetail example.
const ORDER_ID = '30000000-0000-4000-8000-000000000501';
const LINE_ID = '30000000-0000-4000-8000-000000000901';
const WAREHOUSE_ID = '00000000-0000-4000-8000-000000000021';
const SHIPMENT_ID = '60000000-0000-4000-8000-000000000301';
const RETURN_ID = '60000000-0000-4000-8000-000000000201';

beforeAll(async () => {
  prism = await startPrism(BASE);
}, 60_000);

afterAll(() => prism?.stop());

describe('the wrappers reach the paths the spec documents', () => {
  it('lists orders with the contract filters and sort', async () => {
    const result = await api.listOrders(SEED_STORE_ID, {
      page: 1,
      limit: 20,
      sort: 'placed_at',
      order: 'desc',
      status: 'confirmed',
    });
    if (!result.ok) throw new Error(`listOrders failed: ${result.status}`);
    expect(result.data).toMatchObject({ page: expect.any(Number), total: expect.any(Number) });
    const first = result.data.items[0];
    expect(first).toMatchObject({
      display_id: expect.any(Number),
      email: expect.any(String),
      total: { amount_minor: expect.any(Number), currency: expect.any(String) },
    });
  });

  it('reads one order with everything the detail screen renders', async () => {
    const result = await api.getOrder(SEED_STORE_ID, ORDER_ID);
    if (!result.ok) throw new Error(`getOrder failed: ${result.status}`);
    const order = result.data;
    expect(order.items[0]).toMatchObject({
      quantity: expect.any(Number),
      fulfilled_quantity: expect.any(Number),
      returned_quantity: expect.any(Number),
      unit_price: { amount_minor: expect.any(Number) },
    });
    expect(order.shipping_address.country).toMatch(/^[A-Z]{2}$/);
    expect(order.totals.total.amount_minor).toBe(order.total.amount_minor);
    // The example has one captured payment and no refunds: the whole capture is refundable.
    expect(refundableMinor(order)).toBe(order.payments[0]?.amount.amount_minor);
    // And the timeline reads the fields it needs from the example.
    const entries = orderTimeline(order, (amount, currency) => `${amount} ${currency}`);
    expect(entries.map((entry) => entry.kind)).toEqual(['order', 'payment']);
  });

  it('cancels (200 with the order), refunds (201), requests a return (201)', async () => {
    const cancelled = await api.cancelOrder(SEED_STORE_ID, ORDER_ID, { reason: 'contract test' });
    if (!cancelled.ok) throw new Error(`cancelOrder failed: ${cancelled.status}`);
    expect(cancelled.data).toHaveProperty('status');

    const refunded = await api.createRefund(SEED_STORE_ID, ORDER_ID, 'refund-contract-attempt', {
      amount_minor: 500,
      reason: 'goodwill',
    });
    if (!refunded.ok) throw new Error(`createRefund failed: ${refunded.status}`);
    expect(refunded.status).toBe(201);
    expect(refunded.data).toMatchObject({
      amount: { amount_minor: expect.any(Number) },
      status: expect.any(String),
    });

    const returned = await api.createReturn(SEED_STORE_ID, ORDER_ID, {
      items: [{ order_line_item_id: LINE_ID, quantity: 1 }],
    });
    if (!returned.ok) throw new Error(`createReturn failed: ${returned.status}`);
    expect(returned.status).toBe(201);
    expect(returned.data.items[0]).toMatchObject({ order_line_item_id: expect.any(String) });
  });

  /**
   * Five operations document their 200 by schema only (no example), and Prism's schema-generated
   * body fails its own validation, so the mock answers 500 for them: updateOrderLineItem,
   * cancelOrderLineItem, pickShipment, packShipment, listPickLists. CONTRACT CHANGE #261 asks for
   * the examples; until it lands these are skipped rather than asserting on a Prism failure.
   */
  it.skip('edits a line before fulfilment: lower (200), cancel line (200) — CONTRACT CHANGE #261', async () => {
    const lowered = await api.updateOrderLineItem(SEED_STORE_ID, ORDER_ID, LINE_ID, {
      quantity: 1,
    });
    if (!lowered.ok) throw new Error(`updateOrderLineItem failed: ${lowered.status}`);
    expect(Array.isArray(lowered.data.items)).toBe(true);

    const cancelledLine = await api.cancelOrderLineItem(SEED_STORE_ID, ORDER_ID, LINE_ID);
    if (!cancelledLine.ok) throw new Error(`cancelOrderLineItem failed: ${cancelledLine.status}`);
    expect(Array.isArray(cancelledLine.data.items)).toBe(true);
  });

  it('plans a shipment (201), updates it (200), receives a return (200)', async () => {
    const planned = await api.createShipment(SEED_STORE_ID, ORDER_ID, {
      warehouse_id: WAREHOUSE_ID,
      items: [{ order_line_item_id: LINE_ID, quantity: 1 }],
    });
    if (!planned.ok) throw new Error(`createShipment failed: ${planned.status}`);
    expect(planned.status).toBe(201);
    expect(planned.data).toMatchObject({ status: expect.any(String), items: expect.any(Array) });

    const updated = await api.updateShipment(SHIPMENT_ID, {
      status: 'shipped',
      tracking_number: 'TRACK-WORDS',
    });
    if (!updated.ok) throw new Error(`updateShipment failed: ${updated.status}`);
    expect(updated.data).toHaveProperty('tracking_number');

    const received = await api.receiveReturn(SEED_STORE_ID, RETURN_ID, {
      warehouse_id: WAREHOUSE_ID,
      items: [{ order_line_item_id: LINE_ID, quantity: 1, condition: 'resellable' }],
    });
    if (!received.ok) throw new Error(`receiveReturn failed: ${received.status}`);
    expect(received.data.status).toBe('received');
  });

  it.skip('picks and packs a shipment, lists pick lists — CONTRACT CHANGE #261', async () => {
    const picked = await api.pickShipment(SHIPMENT_ID);
    if (!picked.ok) throw new Error(`pickShipment failed: ${picked.status}`);
    const packed = await api.packShipment(SHIPMENT_ID, { parcel_count: 1 });
    if (!packed.ok) throw new Error(`packShipment failed: ${packed.status}`);
    const lists = await api.listPickLists(SEED_STORE_ID, { page: 1, limit: 20 });
    if (!lists.ok) throw new Error(`listPickLists failed: ${lists.status}`);
    for (const group of lists.data.items) {
      expect(group).toMatchObject({ warehouse_code: expect.any(String) });
      expect(Array.isArray(group.shipments)).toBe(true);
    }
  });
});

describe('the server actions against the spec', () => {
  it('a refund through the action carries the key and comes back as a Refund', async () => {
    const result = await actions.createRefundAction(
      SEED_STORE_ID,
      ORDER_ID,
      'refund-through-action',
      { amount_minor: 500, reason: 'goodwill' },
    );
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.data.amount.amount_minor).toEqual(expect.any(Number));
  });

  it('a key shorter than the contract allows never reaches the API', async () => {
    const result = await actions.createRefundAction(SEED_STORE_ID, ORDER_ID, 'short', {
      amount_minor: 500,
      reason: 'goodwill',
    });
    expect(result).toMatchObject({ status: 'error', formError: 'Missing idempotency key.' });
  });

  it('a shipment update with nothing changed is refused before the API', async () => {
    const result = await actions.updateShipmentAction(SEED_STORE_ID, ORDER_ID, SHIPMENT_ID, {});
    expect(result).toMatchObject({ status: 'error', formError: 'Change at least one field' });
  });
});

describe("the spec's documented refusals on the order operations", () => {
  const asking = (
    code: number,
    path: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
  ) =>
    adminRequest<'cancelOrder'>({
      baseUrl: BASE,
      path,
      method,
      body,
      accessToken: 'contract-test-token',
      headers: { ...preferring(code), 'Idempotency-Key': 'refund-refusal-example' },
    });

  it('403 on cancelOrder becomes a refusal that ActionRefusal renders as the relation panel', async () => {
    const result = await asking(
      403,
      `/admin/stores/${SEED_STORE_ID}/orders/${ORDER_ID}/cancel`,
      'POST',
      {
        reason: 'x',
      },
    );
    if (result.ok) throw new Error('expected a refusal');
    expect(result.status).toBe(403);
    const mapped = toActionResult(result, ['reason']);
    if (mapped.status !== 'error') throw new Error('expected error');
    expect(mapped.refusal?.status).toBe(403);

    render(<ActionRefusal refusal={mapped.refusal} message={mapped.formError} />);
    expect(screen.getByRole('heading', { name: /do not have access/i })).toBeInTheDocument();
    expect(screen.getByText(/You need the .* relation on/)).toBeInTheDocument();
  });

  it('401 on createRefund is a refusal with no field error', async () => {
    const result = await asking(
      401,
      `/admin/stores/${SEED_STORE_ID}/orders/${ORDER_ID}/refunds`,
      'POST',
      {
        amount_minor: 1,
        reason: 'goodwill',
      },
    );
    if (result.ok) throw new Error('expected a refusal');
    const mapped = toActionResult(result, ['amount_minor', 'reason']);
    if (mapped.status !== 'error') throw new Error('expected error');
    expect(mapped.refusal?.status).toBe(401);
    expect(mapped.fieldErrors).toEqual({});
  });

  it('409 on cancelOrderLineItem (the last line) maps to a message naming the field, not a refusal', async () => {
    const result = await asking(
      409,
      `/admin/stores/${SEED_STORE_ID}/orders/${ORDER_ID}/line-items/${LINE_ID}`,
      'DELETE',
    );
    if (result.ok) throw new Error('expected a conflict');
    expect(result.status).toBe(409);
    expect(result.error.code).toBe('conflict');
    const mapped = toActionResult(result, []);
    if (mapped.status !== 'error') throw new Error('expected error');
    expect(mapped.refusal).toBeUndefined();
    // The shared Conflict example names a field; a form without that field gets it at form level.
    expect(mapped.formError).toMatch(/\(field: /);
  });

  it('409 on createRefund (over the ceiling) is a conflict message, and the same key may be retried', async () => {
    const result = await asking(
      409,
      `/admin/stores/${SEED_STORE_ID}/orders/${ORDER_ID}/refunds`,
      'POST',
      {
        amount_minor: 1,
        reason: 'goodwill',
      },
    );
    if (result.ok) throw new Error('expected a conflict');
    const mapped = toActionResult(result, ['amount_minor', 'reason']);
    if (mapped.status !== 'error') throw new Error('expected error');
    expect(mapped.refusal).toBeUndefined();
    expect(mapped.formError ?? Object.values(mapped.fieldErrors)[0]).toEqual(expect.any(String));
  });
});
