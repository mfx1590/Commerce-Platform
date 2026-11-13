'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  createCycleCount,
  createStockMovement,
  listStockItems,
  mapVariantToStockItem,
  previewCycleCountReconcile,
  reconcileCycleCount,
  type StockMovementBody,
} from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { actionError, type ActionResult } from '@/lib/forms/action-result';
import { mapServerError } from '@/lib/forms/server-errors';
import { refuseUnlessPermitted } from '@/lib/permissions/guard';
import {
  CYCLE_COUNT_FIELDS,
  cycleCountSchema,
  describeCycleCountError,
  describeMapError,
  describeMovementError,
  formatDelta,
  isSuperseded,
  MOVEMENT_FIELDS,
  moveRefusal,
  movementSchema,
  poolIn,
  type CycleCountValues,
  type MovementKind,
  type MovementValues,
  type PoolNumbers,
} from '@/lib/warehouse';

/**
 * HQ warehouse (#468). Each action refuses server-side, before the API, unless the principal holds
 * `operations` on `organization:hq` (`refuseUnlessPermitted`, `WAREHOUSE_PERMISSIONS`); path ids
 * must be uuids; the count's body is re-validated with the form's schema. Errors come back in the
 * words of window 11's brief (`describeCycleCountError`, `describeMapError`).
 */

type StockItem = AdminComponents['StockItem'];
type CycleCount = AdminComponents['CycleCount'];

const UUID = z.string().uuid();

function invalid(message = 'Some fields are not valid.'): ActionResult<never> {
  return { status: 'error', fieldErrors: {}, formError: message };
}

function refusalOf(status: number, error: AdminComponents['Error']) {
  return status === 401 || status === 403 ? { status, error } : undefined;
}

/** "Pool this variant onto this item" — idempotent; 409 while the old item still holds stock. */
export async function mapVariantAction(
  stockItemId: string,
  variantId: string,
): Promise<ActionResult<StockItem>> {
  const refused = await refuseUnlessPermitted('mapVariantToStockItem', '');
  if (refused !== null) return refused;
  if (!UUID.safeParse(stockItemId).success || !UUID.safeParse(variantId).success) {
    return {
      status: 'error',
      fieldErrors: { variant_id: 'Enter a variant id (uuid).' },
      formError: null,
    };
  }
  const result = await mapVariantToStockItem(stockItemId, variantId);
  if (!result.ok) {
    return actionError(describeMapError(result), refusalOf(result.status, result.error));
  }
  revalidatePath('/warehouse');
  return { status: 'success', data: result.data };
}

/** Writes a count down; changes no stock. */
export async function recordCycleCountAction(
  values: CycleCountValues,
): Promise<ActionResult<CycleCount>> {
  const refused = await refuseUnlessPermitted('createCycleCount', '');
  if (refused !== null) return refused;
  const parsed = cycleCountSchema.safeParse(values);
  if (!parsed.success) return invalid();
  const { counted_at, note, ...rest } = parsed.data;
  const result = await createCycleCount({
    ...rest,
    ...(counted_at === undefined ? {} : { counted_at }),
    ...(note === undefined ? {} : { note }),
  });
  if (!result.ok) {
    return actionError(
      describeCycleCountError(result, CYCLE_COUNT_FIELDS),
      refusalOf(result.status, result.error),
    );
  }
  revalidatePath('/warehouse');
  return { status: 'success', data: result.data };
}

/** Reconcile (no body) → applied or flagged; with `approve`, applies the delta as it is now. */
export async function reconcileCycleCountAction(
  cycleCountId: string,
  approve: boolean,
): Promise<ActionResult<CycleCount>> {
  const refused = await refuseUnlessPermitted('reconcileCycleCount', '');
  if (refused !== null) return refused;
  if (!UUID.safeParse(cycleCountId).success) return invalid('That count is not valid.');
  const result = await reconcileCycleCount(cycleCountId, approve === true);
  if (!result.ok) {
    return actionError(describeCycleCountError(result), refusalOf(result.status, result.error));
  }
  revalidatePath('/warehouse');
  return { status: 'success', data: result.data };
}

// ---------------------------------------------------------------------------- stock movements

/** What a move did, for the form's success line and the ledger it opens. */
export interface MoveOutcome {
  kind: MovementKind;
  stockItemId: string;
  /** The warehouse the ledger opens on: the target, or a transfer's destination. */
  warehouseId: string;
  message: string;
  /** The pool row after the move (a transfer: the destination's). */
  after: PoolNumbers;
}

/** A failure whose outcome the API did not tell us: never followed by a write that assumes one. */
function outcomeUnknown(status: number): boolean {
  return status === 0 || status >= 500;
}

function apiReason(failure: { status: number; error: AdminComponents['Error'] }): string {
  return describeMovementError(failure).formError ?? failure.error.message;
}

/**
 * Receive, adjust or transfer stock (#870 wave 1 item 1). Refused before the API unless the
 * principal holds `operations` on hq. Then the body is re-validated, the item is read FRESH (its
 * pool numbers and a variant that maps it — `createStockMovement` is addressed by variant), and a
 * move below zero or below what open orders reserved is refused here: the core refuses below zero
 * itself (409, its message is shown) but not below reserved, and this read-then-write check holds
 * no lock, so a sale in between can still beat it (REQUEST #877: the real guard, in the core).
 *
 * A transfer is two movements in two transactions (no transfer operation, no idempotency key):
 * `transfer_out` at the source first — a half-done transfer can only understate stock — then
 * `transfer_in` at the destination. When the second is refused, a compensating `transfer_in` puts
 * the units back at the source with a note; when its outcome is unknown (network, 5xx) nothing is
 * written on a guess, and the message says which ledger to check.
 */
export async function moveStockAction(values: MovementValues): Promise<ActionResult<MoveOutcome>> {
  const refused = await refuseUnlessPermitted('createStockMovement', '');
  if (refused !== null) return refused;
  const parsed = movementSchema.safeParse(values);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? '');
      if ((MOVEMENT_FIELDS as readonly string[]).includes(field) && !(field in fieldErrors)) {
        fieldErrors[field] = issue.message;
      }
    }
    return {
      status: 'error',
      fieldErrors,
      formError: Object.keys(fieldErrors).length > 0 ? null : 'Some fields are not valid.',
    };
  }
  const move = parsed.data;

  const items = await listStockItems({ sku: move.sku, limit: 100 });
  if (!items.ok) {
    return actionError(mapServerError(items, []), refusalOf(items.status, items.error));
  }
  const item = items.data.items.find((candidate) => candidate.id === move.stock_item_id);
  if (item === undefined) {
    return invalid('That stock item was not found. Reload the page and try again.');
  }
  const variantId = item.variants[0]?.variant_id;
  if (variantId === undefined) {
    return invalid(
      `No variant maps ${item.sku}, and the Admin API moves stock by variant. Pool a variant onto it first.`,
    );
  }
  const call = (
    warehouseId: string,
    delta: number,
    reason: StockMovementBody['reason'],
    text?: string,
  ) =>
    createStockMovement({
      variant_id: variantId,
      warehouse_id: warehouseId,
      delta,
      reason,
      ...(text === undefined ? {} : { note: text }),
    });
  const done = (warehouseId: string, message: string, level: PoolNumbers) => {
    revalidatePath('/warehouse');
    return {
      status: 'success' as const,
      data: {
        kind: move.kind,
        stockItemId: item.id,
        warehouseId,
        message,
        after: { on_hand: level.on_hand, reserved: level.reserved, available: level.available },
      },
    };
  };
  const failed = (result: { status: number; error: AdminComponents['Error'] }) =>
    actionError(
      describeMovementError(result, MOVEMENT_FIELDS),
      refusalOf(result.status, result.error),
    );

  if (move.kind !== 'transfer') {
    const delta = move.kind === 'adjust' ? move.delta : move.quantity;
    const refusal = moveRefusal(poolIn(item, move.warehouse_id), delta);
    if (refusal !== null) return invalid(refusal);
    const result = await call(
      move.warehouse_id,
      delta,
      move.kind === 'adjust' ? 'adjustment' : 'receipt',
      move.note,
    );
    if (!result.ok) return failed(result);
    return done(
      move.warehouse_id,
      move.kind === 'adjust'
        ? `Adjusted ${item.sku} by ${formatDelta(delta)}.`
        : `Received ${delta} of ${item.sku}.`,
      result.data,
    );
  }

  const { from_warehouse_id: from, to_warehouse_id: to, quantity } = move;
  const refusal = moveRefusal(poolIn(item, from), -quantity, 'the source warehouse');
  if (refusal !== null) return invalid(refusal);
  const out = await call(from, -quantity, 'transfer_out', move.note);
  if (!out.ok) return failed(out);

  const into = await call(to, quantity, 'transfer_in', move.note);
  if (into.ok) {
    return done(to, `Transferred ${quantity} of ${item.sku}.`, into.data);
  }
  revalidatePath('/warehouse');
  if (outcomeUnknown(into.status)) {
    return invalid(
      `${quantity} of ${item.sku} left the source warehouse, and the destination did not answer (${apiReason(into)}). ` +
        `Check the destination's ledger: if no "Transfer in" of ${quantity} appears there, record it as a receipt; do not repeat the whole transfer.`,
    );
  }
  const back = await call(
    from,
    quantity,
    'transfer_in',
    `Returned: the transfer to the destination was refused (${into.error.message}).`,
  );
  if (back.ok) {
    return invalid(
      `The transfer was refused at the destination (${apiReason(into)}). The ${quantity} units were put back in the source warehouse; nothing moved overall.`,
    );
  }
  return invalid(
    `${quantity} of ${item.sku} left the source warehouse and did not arrive: the destination refused (${apiReason(into)}) and putting them back failed (${apiReason(back)}). ` +
      `Check both ledgers and record the ${quantity} units as a receipt where they physically are.`,
  );
}

type CycleCountPreview = AdminComponents['CycleCountPreview'];

/**
 * The approve dialog's preview (`previewCycleCountReconcile`, operations on hq): what reconciling
 * would do now, written nowhere. A 409 superseded comes back with `superseded: true`, so the dialog
 * can say it and refuse to offer Approve.
 */
export async function previewCycleCountAction(
  cycleCountId: string,
): Promise<ActionResult<CycleCountPreview> & { superseded?: true }> {
  const refused = await refuseUnlessPermitted('previewCycleCountReconcile', '');
  if (refused !== null) return refused;
  if (!UUID.safeParse(cycleCountId).success) return invalid('That count is not valid.');
  const result = await previewCycleCountReconcile(cycleCountId);
  if (!result.ok) {
    // A 409 is read by its `details.reason` when it carries one ('superseded' → said, no Approve;
    // any other reason is described as such, never mislabelled). Only a 409 with NO reason — the
    // Prism mock's generated body — falls back to superseded, the one 409 the spec documents.
    if (result.status === 409) {
      const details = (result.error.details as Record<string, unknown> | undefined) ?? {};
      const reason = details['reason'];
      if (typeof reason !== 'string' || reason === '') {
        const assumed = {
          ...result,
          error: { ...result.error, details: { ...details, reason: 'superseded' } },
        };
        return { ...actionError(describeCycleCountError(assumed)), superseded: true as const };
      }
      if (isSuperseded(result.error)) {
        return { ...actionError(describeCycleCountError(result)), superseded: true as const };
      }
    }
    return actionError(describeCycleCountError(result), refusalOf(result.status, result.error));
  }
  return { status: 'success', data: result.data };
}
