/**
 * Stock movements from HQ · Warehouse (#870 wave 1 item 1): `moveStockAction` refuses before the
 * API unless the principal holds `operations` on hq, validates, re-reads the item, refuses a move
 * below zero or below reserved, and a transfer is two movements whose every failure is said — with
 * a compensating movement only when the API answered.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrincipalKey } from './fixtures/principals';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const principalOf = vi.hoisted(() => ({ current: 'operations' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals[principalOf.current as PrincipalKey],
  }),
}));

const api = vi.hoisted(() => ({
  listStockItems: vi.fn(),
  createStockMovement: vi.fn(),
  mapVariantToStockItem: vi.fn(),
  createCycleCount: vi.fn(),
  reconcileCycleCount: vi.fn(),
  previewCycleCountReconcile: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const { moveStockAction } = await import('@/app/actions/warehouse');
const { afterMove, moveRefusal, poolIn } = await import('@/lib/warehouse');

const ITEM = '71000000-0000-4000-8000-000000000001';
const VARIANT = '30000000-0000-4000-8000-000000000301';
const STORE = '00000000-0000-4000-8000-000000000031';
const MAIN = '00000000-0000-4000-8000-000000000021';
const SPARE = '00000000-0000-4000-8000-000000000022';

const ok = (data: unknown, status = 200) => ({ ok: true as const, status, data });
const fail = (status: number, code: string, message: string, details?: unknown) => ({
  ok: false as const,
  status,
  error: { code, message, ...(details === undefined ? {} : { details }) },
});
const level = (warehouse_id: string, on_hand: number, reserved: number) => ({
  warehouse_id,
  on_hand,
  reserved,
  incoming: 0,
  available: on_hand - reserved,
});
const item = (overrides: Record<string, unknown> = {}) => ({
  id: ITEM,
  sku: 'TEE-M-RED',
  name: 'Tee M red',
  barcode: null,
  variants: [{ variant_id: VARIANT, store_id: STORE, sku: 'TEE-M-RED' }],
  levels: [level(MAIN, 10, 8), level(SPARE, 4, 0)],
  ...overrides,
});
const inventoryLevel = (warehouse_id: string, on_hand: number, reserved: number) => ({
  id: '70000000-0000-4000-8000-000000000001',
  store_id: STORE,
  variant_id: VARIANT,
  stock_item_id: ITEM,
  sku: 'TEE-M-RED',
  warehouse_code: 'wh',
  ...level(warehouse_id, on_hand, reserved),
});

const adjust = (delta: string, note = '') => ({
  kind: 'adjust' as const,
  stock_item_id: ITEM,
  sku: 'TEE-M-RED',
  warehouse_id: MAIN,
  delta,
  note,
});
const receive = (quantity: string) => ({
  kind: 'receive' as const,
  stock_item_id: ITEM,
  sku: 'TEE-M-RED',
  warehouse_id: SPARE,
  quantity,
  note: ' pallet 14 ',
});
const transfer = (quantity: string, from = SPARE, to = MAIN) => ({
  kind: 'transfer' as const,
  stock_item_id: ITEM,
  sku: 'TEE-M-RED',
  from_warehouse_id: from,
  to_warehouse_id: to,
  quantity,
  note: 'rebalance',
});

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'operations';
  api.listStockItems.mockResolvedValue(ok({ page: 1, limit: 100, total: 1, items: [item()] }));
  api.createStockMovement.mockResolvedValue(ok(inventoryLevel(MAIN, 12, 8), 201));
});

describe('moveStockAction refuses, server-side, before any read or write', () => {
  it.each(['storeAdmin', 'storeStaff', 'finance', 'support', 'analyst'] as const)(
    '%s is refused',
    async (role) => {
      principalOf.current = role;
      for (const values of [adjust('2'), receive('5'), transfer('1')]) {
        expect(await moveStockAction(values)).toMatchObject({
          status: 'error',
          refusal: {
            status: 403,
            error: { details: { relation: 'operations', object: 'organization:hq' } },
          },
        });
      }
      expect(api.listStockItems).not.toHaveBeenCalled();
      expect(api.createStockMovement).not.toHaveBeenCalled();
    },
  );

  it.each(['operations', 'owner'] as const)('%s reaches the API', async (role) => {
    principalOf.current = role;
    expect((await moveStockAction(adjust('2'))).status).toBe('success');
  });
});

describe('validation', () => {
  it.each([
    [adjust('0'), 'delta'],
    [adjust('1.5'), 'delta'],
    [adjust('x'), 'delta'],
    [receive('0'), 'quantity'],
    [receive('-2'), 'quantity'],
    [transfer('0'), 'quantity'],
    [transfer('1', MAIN, MAIN), 'to_warehouse_id'],
    [{ ...adjust('2'), warehouse_id: 'nope' }, 'warehouse_id'],
  ])('%o → %s, and nothing is called', async (values, field) => {
    const result = await moveStockAction(values);
    expect(result).toMatchObject({ status: 'error', fieldErrors: { [field]: expect.any(String) } });
    expect(api.listStockItems).not.toHaveBeenCalled();
    expect(api.createStockMovement).not.toHaveBeenCalled();
  });

  it('a stock item id that is not a uuid never reaches the API', async () => {
    const result = await moveStockAction({ ...adjust('2'), stock_item_id: 'nope' });
    expect(result.status).toBe('error');
    expect(api.createStockMovement).not.toHaveBeenCalled();
  });
});

describe('adjust and receive', () => {
  it('adjust: addressed by a variant read fresh, reason adjustment, the note kept', async () => {
    const result = await moveStockAction(adjust('2', '  found behind the rack '));
    expect(api.listStockItems).toHaveBeenCalledWith({ sku: 'TEE-M-RED', limit: 100 });
    expect(api.createStockMovement).toHaveBeenCalledExactlyOnceWith({
      variant_id: VARIANT,
      warehouse_id: MAIN,
      delta: 2,
      reason: 'adjustment',
      note: 'found behind the rack',
    });
    expect(result).toMatchObject({
      status: 'success',
      data: {
        kind: 'adjust',
        stockItemId: ITEM,
        warehouseId: MAIN,
        after: { on_hand: 12, reserved: 8, available: 4 },
      },
    });
  });

  it('receive: a positive delta with reason receipt', async () => {
    await moveStockAction(receive('5'));
    expect(api.createStockMovement).toHaveBeenCalledWith(
      expect.objectContaining({
        warehouse_id: SPARE,
        delta: 5,
        reason: 'receipt',
        note: 'pallet 14',
      }),
    );
  });

  it('an empty note is not sent', async () => {
    await moveStockAction(adjust('-1'));
    expect(api.createStockMovement.mock.calls[0]?.[0]).not.toHaveProperty('note');
  });

  it('below reserved is refused without a write (10 on hand, 8 reserved, -3)', async () => {
    const result = await moveStockAction(adjust('-3'));
    expect(result).toMatchObject({
      status: 'error',
      formError: expect.stringContaining('8 reserved'),
    });
    expect(api.createStockMovement).not.toHaveBeenCalled();
    // -2 leaves exactly the reserved 8: allowed.
    expect((await moveStockAction(adjust('-2'))).status).toBe('success');
  });

  it('below zero is refused without a write', async () => {
    api.listStockItems.mockResolvedValue(
      ok({ page: 1, limit: 100, total: 1, items: [item({ levels: [level(MAIN, 1, 0)] })] }),
    );
    const result = await moveStockAction(adjust('-2'));
    expect(result).toMatchObject({
      status: 'error',
      formError: expect.stringContaining('below zero'),
    });
    expect(api.createStockMovement).not.toHaveBeenCalled();
  });

  it('the API’s own 409 is shown in its words (a sale won the race)', async () => {
    api.createStockMovement.mockResolvedValue(
      fail(409, 'conflict', 'on_hand would go negative (1 -2)', { on_hand: 1, delta: -2 }),
    );
    const result = await moveStockAction(adjust('-2'));
    expect(result).toMatchObject({
      status: 'error',
      formError: 'The stock was not moved: on_hand would go negative (1 -2)',
    });
  });

  it('a 404 is said, a 403 from the API is the refusal panel', async () => {
    api.createStockMovement.mockResolvedValueOnce(fail(404, 'not_found', 'variant not found'));
    expect(await moveStockAction(adjust('1'))).toMatchObject({
      formError: expect.stringContaining('no longer maps this item'),
    });
    api.createStockMovement.mockResolvedValueOnce(fail(403, 'forbidden', 'nope'));
    expect(await moveStockAction(adjust('1'))).toMatchObject({ refusal: { status: 403 } });
  });

  it('an item the fresh read does not return is refused', async () => {
    api.listStockItems.mockResolvedValue(ok({ page: 1, limit: 100, total: 0, items: [] }));
    expect(await moveStockAction(adjust('1'))).toMatchObject({
      status: 'error',
      formError: expect.stringContaining('not found'),
    });
    expect(api.createStockMovement).not.toHaveBeenCalled();
  });

  it('an item no variant maps cannot be moved (the API is addressed by variant)', async () => {
    api.listStockItems.mockResolvedValue(
      ok({ page: 1, limit: 100, total: 1, items: [item({ variants: [] })] }),
    );
    expect(await moveStockAction(receive('5'))).toMatchObject({
      status: 'error',
      formError: expect.stringContaining('Pool a variant onto it first'),
    });
    expect(api.createStockMovement).not.toHaveBeenCalled();
  });

  it('a failed read is said, never a write', async () => {
    api.listStockItems.mockResolvedValue(fail(503, 'unavailable', 'down'));
    expect((await moveStockAction(adjust('1'))).status).toBe('error');
    expect(api.createStockMovement).not.toHaveBeenCalled();
  });
});

describe('transfer: two movements, out first', () => {
  const callsOf = () =>
    api.createStockMovement.mock.calls.map(([body]) => [
      body.warehouse_id,
      body.delta,
      body.reason,
    ]);

  it('out of the source, then into the destination; the ledger opens on the destination', async () => {
    api.createStockMovement
      .mockResolvedValueOnce(ok(inventoryLevel(SPARE, 1, 0), 201))
      .mockResolvedValueOnce(ok(inventoryLevel(MAIN, 13, 8), 201));
    const result = await moveStockAction(transfer('3'));
    expect(callsOf()).toEqual([
      [SPARE, -3, 'transfer_out'],
      [MAIN, 3, 'transfer_in'],
    ]);
    expect(api.createStockMovement.mock.calls[0]?.[0]).toMatchObject({
      variant_id: VARIANT,
      note: 'rebalance',
    });
    expect(result).toMatchObject({
      status: 'success',
      data: { kind: 'transfer', warehouseId: MAIN, after: { on_hand: 13, available: 5 } },
    });
  });

  it('the source may not go below its reserved: no call at all', async () => {
    const result = await moveStockAction(transfer('3', MAIN, SPARE)); // MAIN: 10 on hand, 8 reserved
    expect(result).toMatchObject({
      status: 'error',
      formError: expect.stringContaining('reserved'),
    });
    expect(api.createStockMovement).not.toHaveBeenCalled();
  });

  it('the first movement refused: nothing moved, one call', async () => {
    api.createStockMovement.mockResolvedValueOnce(
      fail(409, 'conflict', 'on_hand would go negative (0 -3)'),
    );
    const result = await moveStockAction(transfer('3'));
    expect(result).toMatchObject({
      formError: expect.stringContaining('on_hand would go negative'),
    });
    expect(api.createStockMovement).toHaveBeenCalledTimes(1);
  });

  it('the second refused: the units are put back at the source, and that is said', async () => {
    api.createStockMovement
      .mockResolvedValueOnce(ok(inventoryLevel(SPARE, 1, 0), 201))
      .mockResolvedValueOnce(fail(404, 'not_found', 'warehouse not found'))
      .mockResolvedValueOnce(ok(inventoryLevel(SPARE, 4, 0), 201));
    const result = await moveStockAction(transfer('3'));
    expect(callsOf()).toEqual([
      [SPARE, -3, 'transfer_out'],
      [MAIN, 3, 'transfer_in'],
      [SPARE, 3, 'transfer_in'],
    ]);
    expect(api.createStockMovement.mock.calls[2]?.[0].note).toContain('warehouse not found');
    expect(result).toMatchObject({
      status: 'error',
      formError: expect.stringContaining('put back in the source warehouse; nothing moved overall'),
    });
  });

  it('the second refused and putting back fails too: both errors, and what to do', async () => {
    api.createStockMovement
      .mockResolvedValueOnce(ok(inventoryLevel(SPARE, 1, 0), 201))
      .mockResolvedValueOnce(fail(409, 'conflict', 'refused at destination'))
      .mockResolvedValueOnce(fail(403, 'forbidden', 'role removed meanwhile'));
    const result = await moveStockAction(transfer('3'));
    expect(api.createStockMovement).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('error');
    const message = result.status === 'error' ? (result.formError ?? '') : '';
    expect(message).toContain('left the source warehouse and did not arrive');
    expect(message).toContain('refused at destination');
    expect(message).toContain('record the 3 units as a receipt');
  });

  it.each([0, 502, 504])(
    'the second’s outcome unknown (%i): nothing written on a guess, check the ledger',
    async (status) => {
      api.createStockMovement
        .mockResolvedValueOnce(ok(inventoryLevel(SPARE, 1, 0), 201))
        .mockResolvedValueOnce(fail(status, 'network_error', 'no answer'));
      const result = await moveStockAction(transfer('3'));
      expect(api.createStockMovement).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        status: 'error',
        formError: expect.stringContaining("Check the destination's ledger"),
      });
    },
  );
});

describe('the arithmetic the form and the action share', () => {
  const now = { on_hand: 10, reserved: 8, available: 2 };

  it('afterMove moves on hand and available, never reserved', () => {
    expect(afterMove(now, -2)).toEqual({ on_hand: 8, reserved: 8, available: 0 });
    expect(afterMove(now, 5)).toEqual({ on_hand: 15, reserved: 8, available: 7 });
  });

  it('moveRefusal: below reserved, below zero, or nothing', () => {
    expect(moveRefusal(now, -2)).toBeNull();
    expect(moveRefusal(now, -3)).toContain('At most 2 can go');
    expect(moveRefusal({ on_hand: 1, reserved: 0, available: 1 }, -2)).toContain('below zero');
    expect(moveRefusal(now, 100)).toBeNull();
  });

  it('an increase is never refused, even on a shelf already below reserved', () => {
    expect(moveRefusal({ on_hand: 3, reserved: 5, available: -2 }, 1)).toBeNull();
  });

  it('poolIn: a warehouse the item has no row in reads as zeros', () => {
    expect(poolIn(item(), MAIN)).toEqual({ on_hand: 10, reserved: 8, available: 2 });
    expect(poolIn(item(), '00000000-0000-4000-8000-000000000099')).toEqual({
      on_hand: 0,
      reserved: 0,
      available: 0,
    });
  });
});
