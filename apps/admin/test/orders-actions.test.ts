/**
 * The order server actions check the operation's `x-permission` themselves, before the Admin API is
 * called (house rule; #357 brought every order action under it). One case per action proves the
 * refusal happens before the API; the table is pinned against `admin-api.yaml`; capture and label
 * map the contract's 409 and 422 `provider_unsupported` to words.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrincipalKey } from './fixtures/principals';
import { SEED } from './fixtures/principals';
import { IDS } from './fixtures/orders';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const principalOf = vi.hoisted(() => ({ current: 'storeAdmin' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals[principalOf.current as PrincipalKey],
  }),
}));

const api = vi.hoisted(() => ({
  cancelOrder: vi.fn(),
  updateOrderLineItem: vi.fn(),
  cancelOrderLineItem: vi.fn(),
  capturePayment: vi.fn(),
  createRefund: vi.fn(),
  createReturn: vi.fn(),
  receiveReturn: vi.fn(),
  createShipment: vi.fn(),
  updateShipment: vi.fn(),
  pickShipment: vi.fn(),
  packShipment: vi.fn(),
  buyShipmentLabel: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const actions = await import('@/app/actions/orders');
const { ORDER_PERMISSIONS } = await import('@/lib/orders/permissions');

const STORE = SEED.stores.brandA;
const ORDER = IDS.order;
const KEY = 'idem-key-words-only';

/** action, operation it calls, a role without the relation, a role with it. */
const CASES = [
  [
    'cancelOrderAction',
    'cancelOrder',
    'storeStaff',
    'storeAdmin',
    () => actions.cancelOrderAction(STORE, ORDER, { reason: 'customer asked' }),
  ],
  [
    'lowerLineItemAction',
    'updateOrderLineItem',
    'storeStaff',
    'storeAdmin',
    () => actions.lowerLineItemAction(STORE, ORDER, IDS.lineTee, { quantity: 1 }),
  ],
  [
    'cancelLineItemAction',
    'cancelOrderLineItem',
    'support',
    'storeAdmin',
    () => actions.cancelLineItemAction(STORE, ORDER, IDS.lineTee),
  ],
  [
    'capturePaymentAction',
    'capturePayment',
    'support',
    'storeAdmin',
    () => actions.capturePaymentAction(STORE, ORDER, IDS.payment, {}),
  ],
  [
    'createRefundAction',
    'createRefund',
    'storeStaff',
    'support',
    () =>
      actions.createRefundAction(STORE, ORDER, KEY, {
        amount_minor: 100,
        reason: 'goodwill',
        payment_id: IDS.payment,
      }),
  ],
  [
    'createReturnAction',
    'createReturn',
    'storeStaff',
    'support',
    () =>
      actions.createReturnAction(STORE, ORDER, {
        items: [{ order_line_item_id: IDS.lineTee, quantity: 1 }],
      }),
  ],
  [
    'receiveReturnAction',
    'receiveReturn',
    'storeAdmin',
    'operations',
    () =>
      actions.receiveReturnAction(STORE, ORDER, IDS.ret, {
        warehouse_id: IDS.warehouseEu,
        items: [{ order_line_item_id: IDS.lineTee, quantity: 1, condition: 'resellable' }],
      }),
  ],
  [
    'createShipmentAction',
    'createShipment',
    'storeAdmin',
    'operations',
    () =>
      actions.createShipmentAction(STORE, ORDER, {
        warehouse_id: IDS.warehouseEu,
        carrier: 'manual',
        items: [{ order_line_item_id: IDS.lineTee, quantity: 1 }],
      }),
  ],
  [
    'updateShipmentAction',
    'updateShipment',
    'storeAdmin',
    'operations',
    () => actions.updateShipmentAction(STORE, ORDER, IDS.shipment, { tracking_number: 'TRACK1' }),
  ],
  [
    'pickShipmentAction',
    'pickShipment',
    'storeAdmin',
    'operations',
    () => actions.pickShipmentAction(STORE, ORDER, IDS.shipment),
  ],
  [
    'packShipmentAction',
    'packShipment',
    'storeAdmin',
    'operations',
    () => actions.packShipmentAction(STORE, ORDER, IDS.shipment, { parcel_count: 1 }),
  ],
  [
    'buyShipmentLabelAction',
    'buyShipmentLabel',
    'storeAdmin',
    'operations',
    () => actions.buyShipmentLabelAction(STORE, ORDER, IDS.shipment),
  ],
] as const;

const ok = { ok: true as const, status: 200, data: { id: 'x' } };

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(api)) fn.mockResolvedValue(ok);
});

describe('ORDER_PERMISSIONS is the x-permission admin-api.yaml carries', () => {
  it('every row, and every guarded action has a row', () => {
    const spec = readFileSync(
      resolve(process.cwd(), '../../packages/contracts/openapi/admin-api.yaml'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    for (const [operation, { relation, object }] of Object.entries(ORDER_PERMISSIONS)) {
      const at = spec.indexOf(`operationId: ${operation}\n`);
      expect(at, operation).toBeGreaterThan(-1);
      const permission = /x-permission: \{ relation: (\w+), object: '([^']+)' \}/.exec(
        spec.slice(at, at + 1500),
      );
      expect(permission?.[1], operation).toBe(relation);
      expect(permission?.[2], operation).toBe(
        object === 'organization' ? 'organization:hq' : 'store:{storeId}',
      );
    }
    expect(CASES.map(([, operation]) => operation).sort()).toEqual(
      Object.keys(ORDER_PERMISSIONS).sort(),
    );
  });
});

describe('each order action refuses, server-side, before the API', () => {
  it.each(CASES)(
    '%s (%s): %s refused, %s reaches the API',
    async (_n, operation, without, withIt, call) => {
      const { relation } = ORDER_PERMISSIONS[operation];
      principalOf.current = without;
      expect(await call()).toMatchObject({
        status: 'error',
        refusal: { status: 403, error: { code: 'forbidden', details: { relation } } },
      });
      expect(api[operation]).not.toHaveBeenCalled();

      principalOf.current = withIt;
      expect(await call()).toMatchObject({ status: 'success' });
      expect(api[operation]).toHaveBeenCalledTimes(1);
    },
  );

  it('a path id that is not a uuid never reaches the API', async () => {
    principalOf.current = 'owner';
    expect(await actions.capturePaymentAction(STORE, ORDER, 'pay-1', {})).toMatchObject({
      status: 'error',
      formError: 'That record is not valid.',
    });
    expect(await actions.buyShipmentLabelAction(STORE, ORDER, '../x')).toMatchObject({
      status: 'error',
    });
    expect(api.capturePayment).not.toHaveBeenCalled();
    expect(api.buyShipmentLabel).not.toHaveBeenCalled();
  });
});

describe('capture and label: the contract answers in words', () => {
  beforeEach(() => {
    principalOf.current = 'owner';
  });
  const answer = (status: number, code: string) => ({
    ok: false as const,
    status,
    error: { code, message: `${code} from the core` },
  });

  it('capture sends the partial amount, or nothing for the whole authorisation', async () => {
    await actions.capturePaymentAction(STORE, ORDER, IDS.payment, { amount_minor: 1500 });
    expect(api.capturePayment).toHaveBeenLastCalledWith(STORE, ORDER, IDS.payment, {
      amount_minor: 1500,
    });
    await actions.capturePaymentAction(STORE, ORDER, IDS.payment, {});
    expect(api.capturePayment).toHaveBeenLastCalledWith(STORE, ORDER, IDS.payment, {});
  });

  it('a zero, fractional or extra-field capture body never reaches the API', async () => {
    for (const body of [{ amount_minor: 0 }, { amount_minor: 1.5 }, { amount_minor: 1, x: 1 }]) {
      expect(
        await actions.capturePaymentAction(
          STORE,
          ORDER,
          IDS.payment,
          body as { amount_minor: number },
        ),
      ).toMatchObject({ status: 'error' });
    }
    expect(api.capturePayment).not.toHaveBeenCalled();
  });

  it('422 provider_unsupported is "not available", flagged unavailable, never a refusal', async () => {
    api.capturePayment.mockResolvedValue(answer(422, 'provider_unsupported'));
    const capture = await actions.capturePaymentAction(STORE, ORDER, IDS.payment, {});
    expect(capture).toMatchObject({
      status: 'error',
      unavailable: true,
      formError: expect.stringMatching(/not available for this payment provider/),
    });
    expect(capture).not.toHaveProperty('refusal');

    api.buyShipmentLabel.mockResolvedValue(answer(422, 'provider_unsupported'));
    expect(await actions.buyShipmentLabelAction(STORE, ORDER, IDS.shipment)).toMatchObject({
      unavailable: true,
      formError: expect.stringMatching(/not available for this shipment's carrier.*Update/),
    });
  });

  it('409 is a message naming the conflict, not unavailable', async () => {
    api.capturePayment.mockResolvedValue(answer(409, 'conflict'));
    const capture = await actions.capturePaymentAction(STORE, ORDER, IDS.payment, {});
    expect(capture).toMatchObject({
      status: 'error',
      formError: expect.stringMatching(/conflict from the core/),
    });
    expect(capture).not.toHaveProperty('unavailable');

    api.buyShipmentLabel.mockResolvedValue(answer(409, 'conflict'));
    expect(await actions.buyShipmentLabelAction(STORE, ORDER, IDS.shipment)).toMatchObject({
      formError: expect.stringMatching(/cannot be bought for this shipment now/),
    });
  });
});
