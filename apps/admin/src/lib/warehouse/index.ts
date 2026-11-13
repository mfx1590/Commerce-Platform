/**
 * HQ warehouse (#468): the stock pool and cycle counts. Pure — the form schema, what each error
 * from window 11's brief says on screen, and the small derivations the screens share (who maps an
 * item, which open count of a shelf is the newest, inventory row keys). No React, no `next/*`.
 */

import { z } from 'zod';
import type { AdminComponents, AdminError } from '../api/admin-client';
import type { FormErrors } from '../forms/server-errors';
import { mapServerError } from '../forms/server-errors';

export {
  WAREHOUSE_PERMISSIONS,
  WAREHOUSE_READS,
  warehouseAccess,
  type WarehouseAccess,
  type WarehouseOperation,
} from './permissions';

type StockItem = AdminComponents['StockItem'];
type CycleCount = AdminComponents['CycleCount'];
type InventoryLevel = AdminComponents['InventoryLevel'];

// ---------------------------------------------------------------------------- forms

const UUID = z.string().uuid('Choose one.');

/** `createCycleCount`'s body: an integer ≥ 0; `counted_at` optional (default now), never future. */
export const cycleCountSchema = z.object({
  warehouse_id: UUID,
  stock_item_id: UUID,
  counted_quantity: z.coerce
    .number({ error: 'Enter the number counted.' })
    .int('Whole units only.')
    .min(0, 'A count cannot be negative.'),
  counted_at: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? undefined : value))
    .refine((value) => value === undefined || !Number.isNaN(Date.parse(value)), 'Not a valid time.')
    .refine(
      (value) => value === undefined || Date.parse(value) <= Date.now(),
      'The count’s time cannot be in the future.',
    )
    .transform((value) => (value === undefined ? undefined : new Date(value).toISOString())),
  note: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim())),
});

export type CycleCountValues = z.input<typeof cycleCountSchema>;
export const CYCLE_COUNT_FIELDS = [
  'warehouse_id',
  'stock_item_id',
  'counted_quantity',
  'counted_at',
  'note',
] as const;

// ---------------------------------------------------------------------------- stock movements

/**
 * `createStockMovement` from the warehouse (#870 wave 1 item 1): an adjustment (±, reason
 * `adjustment`), a receipt (+, `receipt`) or a transfer (two movements: `transfer_out` at the
 * source, then `transfer_in` at the destination). The body names the stock item, never a variant:
 * the action picks a variant that maps the item from a fresh read, so a client cannot address
 * another item's stock.
 */
export const MOVEMENT_KINDS = ['adjust', 'receive', 'transfer'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

const note = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim()));

/**
 * The largest movement one request may carry: a typo guard (an extra zero or two), not a business
 * rule. A real delivery above it is split. The form and the action both refuse it.
 */
export const MAX_MOVE_QUANTITY = 100_000;

/** Above this many units the form asks once more, showing the shelf after the move. */
export const CONFIRM_MOVE_ABOVE = 100;

const tooMany = `At most ${MAX_MOVE_QUANTITY.toLocaleString('en')} units per movement.`;

const positiveQuantity = z.coerce
  .number({ error: 'Enter a quantity.' })
  .int('Whole units only.')
  .min(1, 'Enter at least 1.')
  .max(MAX_MOVE_QUANTITY, tooMany);

export const movementSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('adjust'),
    stock_item_id: UUID,
    sku: z.string().trim().min(1, 'Unknown item.'),
    warehouse_id: UUID,
    delta: z.coerce
      .number({ error: 'Enter the change, e.g. -3 or 5.' })
      .int('Whole units only.')
      .refine((value) => value !== 0, 'The change cannot be 0.')
      .refine((value) => Math.abs(value) <= MAX_MOVE_QUANTITY, tooMany),
    note,
  }),
  z.object({
    kind: z.literal('receive'),
    stock_item_id: UUID,
    sku: z.string().trim().min(1, 'Unknown item.'),
    warehouse_id: UUID,
    quantity: positiveQuantity,
    note,
  }),
  z
    .object({
      kind: z.literal('transfer'),
      stock_item_id: UUID,
      sku: z.string().trim().min(1, 'Unknown item.'),
      from_warehouse_id: UUID,
      to_warehouse_id: UUID,
      quantity: positiveQuantity,
      note,
    })
    .refine((value) => value.from_warehouse_id !== value.to_warehouse_id, {
      path: ['to_warehouse_id'],
      message: 'Choose a different warehouse to move to.',
    }),
]);

export type MovementValues = z.input<typeof movementSchema>;
export type ParsedMovement = z.output<typeof movementSchema>;
export const MOVEMENT_FIELDS = [
  'warehouse_id',
  'from_warehouse_id',
  'to_warehouse_id',
  'delta',
  'quantity',
  'note',
] as const;

/** The pool row's numbers the form and the action reason about. */
export interface PoolNumbers {
  on_hand: number;
  reserved: number;
  available: number;
}

/** A warehouse the item is not stocked in yet: the core creates the row at 0 on the first move. */
export const EMPTY_POOL: PoolNumbers = { on_hand: 0, reserved: 0, available: 0 };

/** The item's numbers in one warehouse, or zeros when it has no row there. */
export function poolIn(
  item: Pick<StockItem, 'levels'> | undefined,
  warehouseId: string,
): PoolNumbers {
  const level = item?.levels.find((l) => l.warehouse_id === warehouseId);
  return level === undefined
    ? EMPTY_POOL
    : { on_hand: level.on_hand, reserved: level.reserved, available: level.available };
}

/** What the row would read after `delta` (reservations do not move). */
export function afterMove(now: PoolNumbers, delta: number): PoolNumbers {
  const onHand = now.on_hand + delta;
  return { on_hand: onHand, reserved: now.reserved, available: onHand - now.reserved };
}

/**
 * Why a move must not happen, or null. Below zero is the API's own 409 too; below reserved is not
 * refused by the core (`available` has no check), so the admin refuses it — units promised to
 * orders must stay on the shelf.
 */
export function moveRefusal(
  now: PoolNumbers,
  delta: number,
  where = 'this warehouse',
): string | null {
  const after = afterMove(now, delta);
  if (after.on_hand < 0) {
    return `That would take on hand in ${where} below zero (${now.on_hand} on hand, change ${formatDelta(delta)}).`;
  }
  if (delta < 0 && after.on_hand < now.reserved) {
    return `That would leave ${after.on_hand} on hand in ${where}, fewer than the ${now.reserved} reserved for open orders. At most ${Math.max(0, now.on_hand - now.reserved)} can go.`;
  }
  return null;
}

/** A failure whose outcome the API did not tell (network, 5xx): never repeated or compensated blind. */
export function movementOutcomeUnknown(status: number): boolean {
  return status === 0 || status >= 500;
}

/** `createStockMovement`'s refusals in words; a 409 keeps the API's own message. */
export function describeMovementError(
  failure: { status: number; error: AdminError },
  knownFields: readonly string[] = [],
): FormErrors {
  const { status, error } = failure;
  if (movementOutcomeUnknown(status)) {
    // Status 0 includes a connection reset AFTER the request was sent, and a 5xx can come from a
    // proxy after the core committed. The movement may be recorded; `createStockMovement` has no
    // idempotency key, so "try again" could receive or move the stock twice.
    return {
      fieldErrors: {},
      formError: `Outcome unknown: the Admin API did not confirm this movement (${error.message}). It may have been recorded — check the item's ledger before repeating it.`,
    };
  }
  if (status === 409) {
    return { fieldErrors: {}, formError: `The stock was not moved: ${error.message}` };
  }
  if (status === 404) {
    return {
      fieldErrors: {},
      formError:
        'Not found: the variant no longer maps this item, or the warehouse does not exist. Reload the page and try again.',
    };
  }
  if (status === 400 || status === 422) {
    const mapped = mapServerError({ status: 400, error }, knownFields);
    return Object.keys(mapped.fieldErrors).length > 0
      ? mapped
      : {
          fieldErrors: {},
          formError: `The request was not accepted: ${mapped.formError ?? error.message}`,
        };
  }
  return mapServerError(failure, knownFields);
}

// ---------------------------------------------------------------------------- errors

function details(error: AdminError): Record<string, unknown> {
  return (error.details as Record<string, unknown> | undefined) ?? {};
}

function numberDetail(error: AdminError, key: string): number | null {
  const value = details(error)[key];
  return typeof value === 'number' ? value : null;
}

function stringDetail(error: AdminError, key: string): string | null {
  const value = details(error)[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** `mapVariantToStockItem`'s refusals, in words (401/403 are the screen's refusal panel). */
export function describeMapError(failure: { status: number; error: AdminError }): FormErrors {
  const { status, error } = failure;
  if (status === 409) {
    const onHand = numberDetail(error, 'on_hand');
    const reservations = numberDetail(error, 'open_reservations');
    const held = [
      onHand !== null ? `${onHand} on hand` : null,
      reservations !== null ? `${reservations} open reservations` : null,
    ].filter((part): part is string => part !== null);
    return {
      fieldErrors: {},
      formError:
        'The variant’s current stock item still holds stock or open reservations' +
        (held.length > 0 ? ` (${held.join(', ')})` : '') +
        ' — move the stock first, then pool the variant.',
    };
  }
  if (status === 404) {
    return { fieldErrors: {}, formError: 'That stock item or variant was not found.' };
  }
  return mapServerError(failure, ['variant_id']);
}

/** Whether a 409 is the "can never be applied" kind (the count stays as a record). */
export function isSuperseded(error: AdminError): boolean {
  return stringDetail(error, 'reason') === 'superseded';
}

/**
 * Every refusal of `createCycleCount` / `reconcileCycleCount` from window 11's brief, in words:
 * 409 superseded (a newer applied count, or a hand correction after the count), 409 negative
 * on-hand (recount), 422 `counted_at` in the future (under the field), 404, 400.
 */
export function describeCycleCountError(
  failure: { status: number; error: AdminError },
  knownFields: readonly string[] = [],
): FormErrors {
  const { status, error } = failure;
  if (status === 409 && isSuperseded(error)) {
    const appliedCount = stringDetail(error, 'applied_cycle_count_id');
    const movement = stringDetail(error, 'stock_movement_id');
    const cause =
      movement !== null
        ? `The stock was corrected by hand after this count (movement ${movement}).`
        : appliedCount !== null
          ? `A newer count of this shelf is already applied (count ${appliedCount}).`
          : 'A newer count of this shelf is already applied.';
    return {
      fieldErrors: {},
      formError: `${cause} This count can never be applied; it stays as a record.`,
    };
  }
  if (status === 409) {
    return {
      fieldErrors: {},
      formError:
        'The adjustment would take on-hand below zero — more has shipped since the count than was counted. Count the shelf again.',
    };
  }
  if (status === 422 && stringDetail(error, 'field') === 'counted_at') {
    const message = 'The count’s time is in the future.';
    return knownFields.includes('counted_at')
      ? { fieldErrors: { counted_at: message }, formError: null }
      : { fieldErrors: {}, formError: message };
  }
  if (status === 404) {
    return {
      fieldErrors: {},
      formError:
        'Not found: the count, its warehouse or its stock item does not exist — or the warehouse has been deactivated.',
    };
  }
  if (status === 400 || status === 422) {
    const mapped = mapServerError({ status: 400, error }, knownFields);
    // A field the form owns goes under it; anything else is said as a refused request.
    return Object.keys(mapped.fieldErrors).length > 0
      ? mapped
      : {
          fieldErrors: {},
          formError: `The request was not accepted: ${mapped.formError ?? error.message}`,
        };
  }
  return mapServerError(failure, knownFields);
}

// ---------------------------------------------------------------------------- derivations

/** Distinct stores whose variants map this item. */
export function mappingStores(item: Pick<StockItem, 'variants'>): string[] {
  return [...new Set(item.variants.map((variant) => variant.store_id))];
}

/** Stock item id → how many stores map it (for the "shared with N brands" badge). */
export function sharedStoreCounts(items: readonly Pick<StockItem, 'id' | 'variants'>[]) {
  return new Map(items.map((item) => [item.id, mappingStores(item).length]));
}

/** The key of an inventory row: (variant, warehouse) — `id` is the pool row's and repeats. */
export function inventoryRowKey(level: Pick<InventoryLevel, 'variant_id' | 'warehouse_id'>) {
  return `${level.variant_id}:${level.warehouse_id}`;
}

const OPEN: ReadonlySet<CycleCount['status']> = new Set(['recorded', 'flagged']);

/**
 * Open counts that are NOT the newest open count of their shelf (stock item × warehouse) in the
 * list. Reconcile the newest; older ones then answer 409 superseded.
 */
export function olderOpenCounts(
  counts: readonly Pick<
    CycleCount,
    'id' | 'stock_item_id' | 'warehouse_id' | 'counted_at' | 'status'
  >[],
): Set<string> {
  const newest = new Map<string, { id: string; at: number }>();
  for (const count of counts) {
    if (!OPEN.has(count.status)) continue;
    const shelf = `${count.stock_item_id}:${count.warehouse_id}`;
    const at = Date.parse(count.counted_at);
    const seen = newest.get(shelf);
    if (seen === undefined || at > seen.at) newest.set(shelf, { id: count.id, at });
  }
  const older = new Set<string>();
  for (const count of counts) {
    if (!OPEN.has(count.status)) continue;
    const shelf = `${count.stock_item_id}:${count.warehouse_id}`;
    if (newest.get(shelf)?.id !== count.id) older.add(count.id);
  }
  return older;
}

// ---------------------------------------------------------------------------- ledger and reservations words

/** `StockMovement.reason` in words. */
export const MOVEMENT_REASONS: Record<string, string> = {
  receipt: 'Receipt',
  sale: 'Sale',
  return: 'Return',
  adjustment: 'Adjustment',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
  cycle_count: 'Cycle count',
};

export function movementReasonLabel(reason: string): string {
  return MOVEMENT_REASONS[reason] ?? reason;
}

/** Why a warehouse was chosen for a reservation (window 11's placement rules). */
const ALLOCATION_RULES: Record<string, string> = {
  store_country: 'the store’s country',
  store_default: 'the store’s default warehouse',
  same_country: 'same country as the address',
  same_region: 'same region as the address',
  priority: 'warehouse priority',
};

/**
 * `reservation.allocation_rule` in words: the five rules; `split:<rule>` for the second and later
 * warehouse of a split line; `backorder` for a shortfall reserved anyway; null before 0191. An
 * unknown value is shown as it is rather than hidden.
 */
export function allocationRuleLabel(rule: string | null): string {
  if (rule === null || rule === '') return '—';
  if (rule === 'backorder') return 'backorder — reserved beyond stock';
  if (rule.startsWith('split:')) {
    const inner = rule.slice('split:'.length);
    return `split — further warehouse, by ${ALLOCATION_RULES[inner] ?? inner}`;
  }
  return ALLOCATION_RULES[rule] ?? rule;
}

export const RESERVATION_STATUSES = ['open', 'released', 'all'] as const;

/**
 * A warehouse nothing on the page names: no hq read and no row carrying its `warehouse_code` (a
 * filtered warehouse with no rows). The start of its id.
 */
export function shortWarehouseLabel(id: string): string {
  return `Warehouse ${id.slice(0, 8)}`;
}

/** A signed delta as people read it: +3, −2, 0. */
export function formatDelta(delta: number | null): string {
  if (delta === null) return '—';
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `−${Math.abs(delta)}`;
  return '0';
}

export const CYCLE_COUNT_STATUSES = ['recorded', 'flagged', 'applied'] as const;
