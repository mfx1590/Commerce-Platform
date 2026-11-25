'use server';

import { revalidatePath } from 'next/cache';
import { eraseCustomer, exportCustomer, updateCustomer } from '@/lib/api/admin';
import { compact } from '@/lib/api/payload';
import { toActionResult, type ActionResult } from '@/lib/forms/action-result';
import { refuseUnlessPermitted } from '@/lib/permissions/guard';
import { customerUpdateSchema, fieldNames, type CustomerUpdateValues } from '@/lib/forms/schemas';

function invalid(): ActionResult<never> {
  return { status: 'error', fieldErrors: {}, formError: 'Some fields are not valid.' };
}

function revalidateCustomer(storeId: string, customerId: string): void {
  revalidatePath(`/${storeId}/customers`);
  revalidatePath(`/${storeId}/customers/${customerId}`);
}

/**
 * The values are re-validated with the form's schema; empty strings are dropped so an untouched
 * field is not sent as "" (`compact`), and `customer_group_id: ''` means "clear the group" — the
 * one place an empty string is a real instruction, so it becomes `null` here rather than vanishing.
 *
 * Answers `null`, not the updated record: an action's result is serialised to the client like a
 * prop, and the form does not need the email, phone or consent to know the save succeeded.
 */
export async function updateCustomerAction(
  storeId: string,
  customerId: string,
  values: CustomerUpdateValues,
): Promise<ActionResult<null>> {
  const refused = await refuseUnlessPermitted('updateCustomer', storeId);
  if (refused) return refused;
  const parsed = customerUpdateSchema.safeParse(values);
  if (!parsed.success) return invalid();
  const { customer_group_id, ...rest } = parsed.data;
  const body = {
    ...compact(rest),
    ...(customer_group_id === undefined
      ? {}
      : { customer_group_id: customer_group_id === '' ? null : customer_group_id }),
  };
  const result = await updateCustomer(storeId, customerId, body);
  if (result.ok) revalidateCustomer(storeId, customerId);
  const mapped = toActionResult(result, fieldNames(customerUpdateSchema));
  return mapped.status === 'success' ? { status: 'success', data: null } : mapped;
}

/**
 * Schedules a GDPR export: 202, no body, so success is "scheduled" and the trail re-reads.
 *
 * `store_admin`, refused here before the request is sent. `support` is enough to read a customer on
 * screen; it is not enough to have a bundle of everything held about them built. Nothing about the
 * customer is returned to the caller and nothing is logged.
 */
export async function requestCustomerExportAction(
  storeId: string,
  customerId: string,
): Promise<ActionResult<null>> {
  const refused = await refuseUnlessPermitted('exportCustomer', storeId);
  if (refused) return refused;
  const result = await exportCustomer(storeId, customerId);
  if (result.ok) revalidateCustomer(storeId, customerId);
  const mapped = toActionResult(result, []);
  return mapped.status === 'success' ? { status: 'success', data: null } : mapped;
}

/**
 * 202, no body: the screen re-reads to show `status: erased`. No PII is logged anywhere here.
 * Irreversible: a principal without `store_admin` on the store is refused before the request is sent.
 */
export async function eraseCustomerAction(
  storeId: string,
  customerId: string,
): Promise<ActionResult<null>> {
  const refused = await refuseUnlessPermitted('eraseCustomer', storeId);
  if (refused) return refused;
  const result = await eraseCustomer(storeId, customerId);
  if (result.ok) revalidateCustomer(storeId, customerId);
  return toActionResult(result, []);
}
