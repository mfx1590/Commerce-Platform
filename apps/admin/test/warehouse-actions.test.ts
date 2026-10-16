/**
 * HQ warehouse server actions (#468): operations on organization:hq, checked before the API; the
 * table is the yaml's; every refusal from window 11's brief comes back in words.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  mapVariantToStockItem: vi.fn(),
  createCycleCount: vi.fn(),
  reconcileCycleCount: vi.fn(),
  previewCycleCountReconcile: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const actions = await import('@/app/actions/warehouse');
const { WAREHOUSE_PERMISSIONS, WAREHOUSE_READS, allocationRuleLabel, movementReasonLabel } =
  await import('@/lib/warehouse');

const ITEM = '71000000-0000-4000-8000-000000000001';
const VARIANT = '30000000-0000-4000-8000-000000000301';
const COUNT = '72000000-0000-4000-8000-000000000001';
const WAREHOUSE = '00000000-0000-4000-8000-000000000021';
const count = {
  warehouse_id: WAREHOUSE,
  stock_item_id: ITEM,
  counted_quantity: '38',
  counted_at: undefined,
  note: '',
};

const ok = (data: unknown, status = 200) => ({ ok: true as const, status, data });
const fail = (status: number, code: string, message: string, details?: unknown) => ({
  ok: false as const,
  status,
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'operations';
  api.mapVariantToStockItem.mockResolvedValue(ok({ id: ITEM }));
  api.createCycleCount.mockResolvedValue(ok({ id: COUNT, status: 'recorded' }, 201));
  api.reconcileCycleCount.mockResolvedValue(ok({ id: COUNT, status: 'applied', delta: -2 }));
  api.previewCycleCountReconcile.mockResolvedValue(
    ok({
      cycle_count_id: COUNT,
      on_hand_as_of_count: 40,
      delta: -2,
      count_tolerance: 0,
      would_status: 'flagged',
      computed_at: '2026-10-15T09:00:00Z',
    }),
  );
});

const calls = {
  mapVariantToStockItem: () => actions.mapVariantAction(ITEM, VARIANT),
  createCycleCount: () => actions.recordCycleCountAction(count),
  reconcileCycleCount: () => actions.reconcileCycleCountAction(COUNT, false),
  previewCycleCountReconcile: () => actions.previewCycleCountAction(COUNT),
} as const;

describe('the warehouse tables are the x-permission admin-api.yaml carries', () => {
  const spec = readFileSync(
    resolve(process.cwd(), '../../packages/contracts/openapi/admin-api.yaml'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const permissionOf = (operation: string) => {
    const at = spec.indexOf(`operationId: ${operation}\n`);
    expect(at, operation).toBeGreaterThan(-1);
    return /x-permission: \{ relation: (\w+), object: '([^']+)' \}/.exec(spec.slice(at, at + 2000));
  };

  it('every mutation', () => {
    for (const [operation, { relation }] of Object.entries(WAREHOUSE_PERMISSIONS)) {
      const permission = permissionOf(operation);
      expect(permission?.[1], operation).toBe(relation);
      expect(permission?.[2], operation).toBe('organization:hq');
    }
  });

  it('every read', () => {
    for (const [operation, { relation, object }] of Object.entries(WAREHOUSE_READS)) {
      const permission = permissionOf(operation);
      expect(permission?.[1], operation).toBe(relation);
      expect(permission?.[2], operation).toBe(object);
    }
  });
});

describe('each warehouse action refuses, server-side, before the API', () => {
  it.each(['storeAdmin', 'storeStaff', 'finance', 'support', 'analyst'] as const)(
    '%s is refused every action',
    async (role) => {
      principalOf.current = role;
      for (const [name, call] of Object.entries(calls)) {
        expect(await call(), name).toMatchObject({
          status: 'error',
          refusal: {
            status: 403,
            error: { details: { relation: 'operations', object: 'organization:hq' } },
          },
        });
      }
      expect(api.mapVariantToStockItem).not.toHaveBeenCalled();
      expect(api.createCycleCount).not.toHaveBeenCalled();
      expect(api.reconcileCycleCount).not.toHaveBeenCalled();
      expect(api.previewCycleCountReconcile).not.toHaveBeenCalled();
    },
  );

  it.each(['operations', 'owner'] as const)('%s reaches the API', async (role) => {
    principalOf.current = role;
    for (const [name, call] of Object.entries(calls)) {
      expect((await call()).status, name).toBe('success');
    }
  });

  it('non-uuid ids never reach the API', async () => {
    expect(await actions.mapVariantAction(ITEM, 'nope')).toMatchObject({
      status: 'error',
      fieldErrors: { variant_id: expect.any(String) },
    });
    expect((await actions.reconcileCycleCountAction('nope', false)).status).toBe('error');
    expect(api.mapVariantToStockItem).not.toHaveBeenCalled();
    expect(api.reconcileCycleCount).not.toHaveBeenCalled();
  });
});

describe('mapVariantAction', () => {
  it('409: the old item still holds stock — move it first, with the numbers', async () => {
    api.mapVariantToStockItem.mockResolvedValue(
      fail(409, 'conflict', 'current stock item still holds stock', {
        stock_item_id: ITEM,
        on_hand: 4,
        open_reservations: 1,
      }),
    );
    const result = await actions.mapVariantAction(ITEM, VARIANT);
    expect(result).toMatchObject({ status: 'error' });
    expect(result.status === 'error' && result.formError).toMatch(
      /still holds stock or open reservations \(4 on hand, 1 open reservations\) — move the stock first/,
    );
  });

  it('404: unknown item or variant', async () => {
    api.mapVariantToStockItem.mockResolvedValue(fail(404, 'not_found', 'not found'));
    const result = await actions.mapVariantAction(ITEM, VARIANT);
    expect(result.status === 'error' && result.formError).toMatch(
      /stock item or variant was not found/,
    );
  });

  it('a server 403 is the refusal panel', async () => {
    api.mapVariantToStockItem.mockResolvedValue(
      fail(403, 'forbidden', 'requires operations on organization:hq'),
    );
    expect(await actions.mapVariantAction(ITEM, VARIANT)).toMatchObject({
      status: 'error',
      refusal: { status: 403 },
    });
  });
});

describe('recordCycleCountAction', () => {
  it('sends the parsed body: quantity a number, empty note and time left out', async () => {
    await actions.recordCycleCountAction(count);
    expect(api.createCycleCount).toHaveBeenCalledWith({
      warehouse_id: WAREHOUSE,
      stock_item_id: ITEM,
      counted_quantity: 38,
    });
  });

  it('refuses a negative or fractional count before the API', async () => {
    for (const counted_quantity of ['-1', '2.5']) {
      expect((await actions.recordCycleCountAction({ ...count, counted_quantity })).status).toBe(
        'error',
      );
    }
    expect(api.createCycleCount).not.toHaveBeenCalled();
  });

  it('422 counted_at in the future lands under the field', async () => {
    api.createCycleCount.mockResolvedValue(
      fail(422, 'validation_error', 'counted_at may not be in the future', { field: 'counted_at' }),
    );
    expect(await actions.recordCycleCountAction(count)).toMatchObject({
      status: 'error',
      fieldErrors: { counted_at: 'The count’s time is in the future.' },
    });
  });

  it('409 superseded: a later count is already applied', async () => {
    api.createCycleCount.mockResolvedValue(
      fail(409, 'conflict', 'a later count has been applied', {
        reason: 'superseded',
        applied_cycle_count_id: '72000000-0000-4000-8000-000000000002',
      }),
    );
    const result = await actions.recordCycleCountAction(count);
    expect(result.status === 'error' && result.formError).toMatch(
      /newer count of this shelf is already applied \(count 72000000-0000-4000-8000-000000000002\)/,
    );
  });

  it('404: unknown warehouse or stock item', async () => {
    api.createCycleCount.mockResolvedValue(fail(404, 'not_found', 'not found'));
    const result = await actions.recordCycleCountAction(count);
    expect(result.status === 'error' && result.formError).toMatch(/^Not found/);
  });

  it('400 naming a field lands under it', async () => {
    api.createCycleCount.mockResolvedValue(
      fail(400, 'validation_error', 'must be an integer', { field: 'counted_quantity' }),
    );
    expect(await actions.recordCycleCountAction(count)).toMatchObject({
      fieldErrors: { counted_quantity: 'must be an integer' },
    });
  });
});

describe('reconcileCycleCountAction', () => {
  it('reconcile sends no body; approve sends approve', async () => {
    await actions.reconcileCycleCountAction(COUNT, false);
    expect(api.reconcileCycleCount).toHaveBeenLastCalledWith(COUNT, false);
    await actions.reconcileCycleCountAction(COUNT, true);
    expect(api.reconcileCycleCount).toHaveBeenLastCalledWith(COUNT, true);
  });

  const errors: Array<[string, ReturnType<typeof fail>, RegExp]> = [
    [
      '409 superseded by a newer applied count',
      fail(409, 'conflict', 'superseded', {
        reason: 'superseded',
        applied_cycle_count_id: '72000000-0000-4000-8000-000000000002',
      }),
      /newer count of this shelf is already applied.*can never be applied; it stays as a record/,
    ],
    [
      '409 superseded by a hand correction',
      fail(409, 'conflict', 'superseded', {
        reason: 'superseded',
        stock_movement_id: '73000000-0000-4000-8000-000000000009',
      }),
      /corrected by hand after this count \(movement 73000000-0000-4000-8000-000000000009\)/,
    ],
    [
      '409 on-hand would go negative',
      fail(409, 'conflict', 'on hand would go below zero'),
      /below zero.*Count the shelf again/,
    ],
    ['404 (incl. a deactivated warehouse)', fail(404, 'not_found', 'not found'), /deactivated/],
    [
      '400 malformed',
      fail(400, 'validation_error', 'body must be an object'),
      /not accepted: body must be an object/,
    ],
  ];
  it.each(errors)('%s', async (_name, failure, words) => {
    api.reconcileCycleCount.mockResolvedValue(failure);
    const result = await actions.reconcileCycleCountAction(COUNT, true);
    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.formError).toMatch(words);
  });
});

describe('previewCycleCountAction', () => {
  it('answers the preview', async () => {
    expect(await actions.previewCycleCountAction(COUNT)).toMatchObject({
      status: 'success',
      data: { delta: -2, would_status: 'flagged' },
    });
    expect(api.previewCycleCountReconcile).toHaveBeenCalledWith(COUNT);
  });

  it('409 superseded is said and flagged as superseded', async () => {
    api.previewCycleCountReconcile.mockResolvedValue(
      fail(409, 'conflict', 'superseded', {
        reason: 'superseded',
        applied_cycle_count_id: '72000000-0000-4000-8000-000000000002',
      }),
    );
    const result = await actions.previewCycleCountAction(COUNT);
    expect(result).toMatchObject({ status: 'error', superseded: true });
    expect(result.status === 'error' && result.formError).toMatch(
      /newer count of this shelf is already applied/,
    );
  });

  it('a 409 without details.reason (the mock) falls back to superseded', async () => {
    api.previewCycleCountReconcile.mockResolvedValue(fail(409, 'conflict', 'conflict'));
    const result = await actions.previewCycleCountAction(COUNT);
    expect(result).toMatchObject({ status: 'error', superseded: true });
    expect(result.status === 'error' && result.formError).toMatch(/can never be applied/);
  });

  it('a 409 with another details.reason is not mislabelled as superseded', async () => {
    api.previewCycleCountReconcile.mockResolvedValue(
      fail(409, 'conflict', 'on hand would go below zero', { reason: 'negative_on_hand' }),
    );
    const result = await actions.previewCycleCountAction(COUNT);
    expect(result).toMatchObject({ status: 'error' });
    expect(result).not.toHaveProperty('superseded');
    expect(result.status === 'error' && result.formError).toMatch(/below zero/);
  });

  it('404 is said, and is not superseded', async () => {
    api.previewCycleCountReconcile.mockResolvedValue(fail(404, 'not_found', 'not found'));
    const result = await actions.previewCycleCountAction(COUNT);
    expect(result).not.toHaveProperty('superseded');
    expect(result.status === 'error' && result.formError).toMatch(/^Not found/);
  });

  it('a non-uuid count never reaches the API', async () => {
    expect((await actions.previewCycleCountAction('nope')).status).toBe('error');
    expect(api.previewCycleCountReconcile).not.toHaveBeenCalled();
  });
});

describe('ledger and reservation words', () => {
  it.each([
    ['receipt', 'Receipt'],
    ['sale', 'Sale'],
    ['return', 'Return'],
    ['adjustment', 'Adjustment'],
    ['transfer_in', 'Transfer in'],
    ['transfer_out', 'Transfer out'],
    ['cycle_count', 'Cycle count'],
    ['something_new', 'something_new'],
  ])('reason %s reads %s', (reason, words) => {
    expect(movementReasonLabel(reason)).toBe(words);
  });

  it.each([
    ['store_country', 'the store’s country'],
    ['store_default', 'the store’s default warehouse'],
    ['same_country', 'same country as the address'],
    ['same_region', 'same region as the address'],
    ['priority', 'warehouse priority'],
    ['split:priority', 'split — further warehouse, by warehouse priority'],
    ['split:mystery', 'split — further warehouse, by mystery'],
    ['backorder', 'backorder — reserved beyond stock'],
    ['mystery', 'mystery'],
  ])('allocation rule %s reads %s', (rule, words) => {
    expect(allocationRuleLabel(rule)).toBe(words);
  });

  it('a reservation from before 0191 has no rule', () => {
    expect(allocationRuleLabel(null)).toBe('—');
  });
});
