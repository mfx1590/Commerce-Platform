'use server';

import { revalidatePath } from 'next/cache';
import {
  cancelOrder,
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

type Order = AdminComponents['Order'];
type Refund = AdminComponents['Refund'];
type Return = AdminComponents['Return'];
type Shipment = AdminComponents['Shipment'];

/**
 * Every order mutation goes through here: the values are re-validated with the same Zod schema
 * the form used, the Admin API re-checks the operation's `x-permission`, and a refusal comes back
 * as an `ActionResult` refusal for `ActionRefusal` to render — never a silent no-op.
 */

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
  const parsed = shipmentUpdateSchema.safeParse(values);
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message);
  const result = await updateShipment(shipmentId, compact(parsed.data));
  if (result.ok) revalidateOrder(storeId, orderId);
  return toActionResult(result, [
    'status',
    'tracking_number',
    'tracking_url',
    'label_url',
    'cost_minor',
  ]);
}

export async function pickShipmentAction(
  storeId: string,
  orderId: string,
  shipmentId: string,
): Promise<ActionResult<Shipment>> {
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
  const parsed = shipmentPackSchema.safeParse(values);
  if (!parsed.success) return invalid();
  const result = await packShipment(shipmentId, compact(parsed.data));
  if (result.ok) revalidateOrder(storeId, orderId);
  return toActionResult(result, fieldNames(shipmentPackSchema));
}
