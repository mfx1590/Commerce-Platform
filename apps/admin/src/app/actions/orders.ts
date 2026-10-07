'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  buyShipmentLabel,
  cancelOrder,
  capturePayment,
  cancelOrderLineItem,
  createRefund,
  createReturn,
  createShipment,
  packShipment,
  pickShipment,
  receiveReturn,
  updateOrderLineItem,
  updateShipment,
} from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { compact } from '@/lib/api/payload';
import { toActionResult, type ActionResult } from '@/lib/forms/action-result';
import {
  fieldNames,
  lineItemQuantitySchema,
  orderCancelSchema,
  refundCreateSchema,
  returnCreateSchema,
  returnReceiveSchema,
  shipmentCreateSchema,
  shipmentPackSchema,
  shipmentUpdateSchema,
  type LineItemQuantityValues,
  type OrderCancelValues,
  type RefundCreateValues,
  type ReturnCreateValues,
  type ReturnReceiveValues,
  type ShipmentCreateValues,
  type ShipmentPackValues,
  type ShipmentUpdateValues,
} from '@/lib/forms/schemas';
import { isValidIdempotencyKey } from '@/lib/orders/refunds';
import { refuseUnlessPermitted, type GuardedOperation } from '@/lib/permissions/guard';

type Order = AdminComponents['Order'];
type Refund = AdminComponents['Refund'];
type Return = AdminComponents['Return'];
type Shipment = AdminComponents['Shipment'];
type Payment = AdminComponents['Payment'];

/**
 * Every order mutation goes through here. Each one first refuses, server-side and before the API,
 * unless the principal holds the operation's `x-permission` (`ORDER_PERMISSIONS`, via
 * `refuseUnlessPermitted`) — a server action is a public POST whatever the page offered — and
 * checks the path ids are uuids. Then the values are re-validated with the same Zod schema the form
 * used, the Admin API re-checks the permission, and a refusal comes back as an `ActionResult`
 * refusal for `ActionRefusal` to render — never a silent no-op.
 */

const UUID = z.string().uuid();

/** The permission first, then the path ids; null when the call may go ahead. */
async function precheck(
  operation: GuardedOperation,
  storeId: string,
  ...ids: string[]
): Promise<ActionResult<never> | null> {
  const refused = await refuseUnlessPermitted(operation, storeId);
  if (refused !== null) return refused;
  if (ids.some((id) => !UUID.safeParse(id).success)) return invalid('That record is not valid.');
  return null;
}

/** The provider/carrier cannot do this (422 `provider_unsupported`): said, not shown as a failure. */
function unavailable(message: string): ActionResult<never> {
  return { status: 'error', fieldErrors: {}, formError: message, unavailable: true };
}

function invalid(message = 'Some fields are not valid.'): ActionResult<never> {
  return { status: 'error', fieldErrors: {}, formError: message };
}

function revalidateOrder(storeId: string, orderId: string): void {
  revalidatePath(`/${storeId}/orders`);
  revalidatePath(`/${storeId}/orders/${orderId}`);
  revalidatePath(`/${storeId}/orders/pick-lists`);
}

export async function cancelOrderAction(
  storeId: string,
  orderId: string,
  values: OrderCancelValues,
): Promise<ActionResult<Order>> {
  const blocked = await precheck('cancelOrder', storeId, orderId);
  if (blocked !== null) return blocked;
  const parsed = orderCancelSchema.safeParse(values);
  if (!parsed.success) return invalid();
  const result = await cancelOrder(storeId, orderId, parsed.data);
  if (result.ok) revalidateOrder(storeId, orderId);
  return toActionResult(result, fieldNames(orderCancelSchema));
}

export async function lowerLineItemAction(
  storeId: string,
  orderId: string,
  lineItemId: string,
  values: LineItemQuantityValues,
): Promise<ActionResult<Order>> {
  const blocked = await precheck('updateOrderLineItem', storeId, orderId, lineItemId);
  if (blocked !== null) return blocked;
  const parsed = lineItemQuantitySchema.safeParse(values);
  if (!parsed.success) return invalid();
  const result = await updateOrderLineItem(storeId, orderId, lineItemId, parsed.data);
  if (result.ok) revalidateOrder(storeId, orderId);
  return toActionResult(result, fieldNames(lineItemQuantitySchema));
}

export async function cancelLineItemAction(
  storeId: string,
  orderId: string,
  lineItemId: string,
): Promise<ActionResult<Order>> {
  const blocked = await precheck('cancelOrderLineItem', storeId, orderId, lineItemId);
  if (blocked !== null) return blocked;
  const result = await cancelOrderLineItem(storeId, orderId, lineItemId);
  if (result.ok) revalidateOrder(storeId, orderId);
  return toActionResult(result, []);
}

/**
 * The idempotency key is minted by the form for the *attempt* and re-sent unchanged on a retry
 * (`src/lib/orders/refunds.ts`); this only checks it is one the contract accepts.
 */
export async function createRefundAction(
  storeId: string,
  orderId: string,
  idempotencyKey: string,
  values: RefundCreateValues,
): Promise<ActionResult<Refund>> {
  const blocked = await precheck('createRefund', storeId, orderId);
  if (blocked !== null) return blocked;
  if (!isValidIdempotencyKey(idempotencyKey)) return invalid('Missing idempotency key.');
  const parsed = refundCreateSchema.safeParse(values);
  if (!parsed.success) return invalid();
  const result = await createRefund(storeId, orderId, idempotencyKey, compact(parsed.data));
  if (result.ok) revalidateOrder(storeId, orderId);
  return toActionResult(result, fieldNames(refundCreateSchema));
}

export async function createReturnAction(
  storeId: string,
  orderId: string,
  values: ReturnCreateValues,
): Promise<ActionResult<Return>> {
  const blocked = await precheck('createReturn', storeId, orderId);
  if (blocked !== null) return blocked;
  const parsed = returnCreateSchema.safeParse(values);
  if (!parsed.success) return invalid();
  const result = await createReturn(storeId, orderId, compact(parsed.data));
  if (result.ok) revalidateOrder(storeId, orderId);
  return toActionResult(result, fieldNames(returnCreateSchema));
}

export async function receiveReturnAction(
  storeId: string,
  orderId: string,
  returnId: string,
  values: ReturnReceiveValues,
): Promise<ActionResult<Return>> {
  const blocked = await precheck('receiveReturn', storeId, orderId, returnId);
  if (blocked !== null) return blocked;
  const parsed = returnReceiveSchema.safeParse(values);
  if (!parsed.success) return invalid();
  const result = await receiveReturn(storeId, returnId, parsed.data);
  if (result.ok) revalidateOrder(storeId, orderId);
  return toActionResult(result, fieldNames(returnReceiveSchema));
}

export async function createShipmentAction(
  storeId: string,
  orderId: string,
  values: ShipmentCreateValues,
): Promise<ActionResult<Shipment>> {
  const blocked = await precheck('createShipment', storeId, orderId);
  if (blocked !== null) return blocked;
  const parsed = shipmentCreateSchema.safeParse(values);
  if (!parsed.success) return invalid();
  const result = await createShipment(storeId, orderId, compact(parsed.data));
  if (result.ok) revalidateOrder(storeId, orderId);
  return toActionResult(result, fieldNames(shipmentCreateSchema));
}

export async function updateShipmentAction(
  storeId: string,
  orderId: string,
  shipmentId: string,
  values: ShipmentUpdateValues,
): Promise<ActionResult<Shipment>> {
  const blocked = await precheck('updateShipment', storeId, orderId, shipmentId);
  if (blocked !== null) return blocked;
  const parsed = shipmentUpdateSchema.safeParse(values);
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message);
  const result = await updateShipment(shipmentId, compact(parsed.data));
  if (result.ok) revalidateOrder(storeId, orderId);
  return toActionResult(result, fieldNames(shipmentUpdateSchema));
}

export async function pickShipmentAction(
  storeId: string,
  orderId: string,
  shipmentId: string,
): Promise<ActionResult<Shipment>> {
  const blocked = await precheck('pickShipment', storeId, orderId, shipmentId);
  if (blocked !== null) return blocked;
  const result = await pickShipment(shipmentId);
  if (result.ok) revalidateOrder(storeId, orderId);
  return toActionResult(result, []);
}

export async function packShipmentAction(
  storeId: string,
  orderId: string,
  shipmentId: string,
  values: ShipmentPackValues,
): Promise<ActionResult<Shipment>> {
  const blocked = await precheck('packShipment', storeId, orderId, shipmentId);
  if (blocked !== null) return blocked;
  const parsed = shipmentPackSchema.safeParse(values);
  if (!parsed.success) return invalid();
  const result = await packShipment(shipmentId, compact(parsed.data));
  if (result.ok) revalidateOrder(storeId, orderId);
  return toActionResult(result, fieldNames(shipmentPackSchema));
}

const captureSchema = z.object({ amount_minor: z.number().int().min(1).optional() }).strict();

/**
 * `capturePayment` — the whole authorisation, or `amount_minor` of it. The screen asks first and
 * never offers more than the authorised amount; the core refuses that anyway (409), and a provider
 * that cannot capture (422 `provider_unsupported`, the manual provider) is said in plain words.
 */
export async function capturePaymentAction(
  storeId: string,
  orderId: string,
  paymentId: string,
  values: { amount_minor?: number },
): Promise<ActionResult<Payment>> {
  const blocked = await precheck('capturePayment', storeId, orderId, paymentId);
  if (blocked !== null) return blocked;
  const parsed = captureSchema.safeParse(values);
  if (!parsed.success) return invalid('Enter a whole amount of at least one minor unit.');
  const result = await capturePayment(storeId, orderId, paymentId, compact(parsed.data));
  if (result.ok) {
    revalidateOrder(storeId, orderId);
    return { status: 'success', data: result.data };
  }
  if (result.status === 422 && result.error.code === 'provider_unsupported') {
    return unavailable(
      'Capture is not available for this payment provider — it has nothing to capture.',
    );
  }
  if (result.status === 409) {
    return invalid(
      `This payment cannot be captured as asked: ${result.error.message}. Reload to see its current state.`,
    );
  }
  return toActionResult(result, fieldNames(captureSchema));
}

/**
 * `buyShipmentLabel` — buys the label through the store's carrier; the shipment comes back
 * `label_created` with the label link and tracking. The manual carrier cannot buy labels (422
 * `provider_unsupported`): tracking is attached with Update instead, and the screen says so.
 */
export async function buyShipmentLabelAction(
  storeId: string,
  orderId: string,
  shipmentId: string,
): Promise<ActionResult<Shipment>> {
  const blocked = await precheck('buyShipmentLabel', storeId, orderId, shipmentId);
  if (blocked !== null) return blocked;
  const result = await buyShipmentLabel(shipmentId);
  if (result.ok) {
    revalidateOrder(storeId, orderId);
    return { status: 'success', data: result.data };
  }
  if (result.status === 422 && result.error.code === 'provider_unsupported') {
    return unavailable(
      "Buying a label is not available for this shipment's carrier — attach the tracking number with Update instead.",
    );
  }
  if (result.status === 409) {
    return invalid(
      `A label cannot be bought for this shipment now: ${result.error.message}. Reload to see its current state.`,
    );
  }
  return toActionResult(result, []);
}
