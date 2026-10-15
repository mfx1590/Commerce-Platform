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
    return mapped.formError === null && Object.keys(mapped.fieldErrors).length === 0
      ? { fieldErrors: {}, formError: `The request was not accepted: ${error.message}` }
      : mapped;
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

/** A signed delta as people read it: +3, −2, 0. */
export function formatDelta(delta: number | null): string {
  if (delta === null) return '—';
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `−${Math.abs(delta)}`;
  return '0';
}

export const CYCLE_COUNT_STATUSES = ['recorded', 'flagged', 'applied'] as const;
