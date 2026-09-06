'use server';

import { revalidatePath } from 'next/cache';
import {
  addDomain,
  createApiKey,
  createSalesChannel,
  createStore,
  updateStore,
} from '@/lib/api/admin';
import { toActionResult, type ActionResult } from '@/lib/forms/action-result';
import { compact } from '@/lib/api/payload';
import type { AdminComponents } from '@/lib/api/admin-client';
import {
  apiKeyCreateSchema,
  domainCreateSchema,
  salesChannelCreateSchema,
  storeCreateSchema,
  storeUpdateSchema,
  type ApiKeyCreateValues,
  type DomainCreateValues,
  type SalesChannelCreateValues,
  type StoreCreateValues,
  type StoreUpdateValues,
} from '@/lib/forms/schemas';
import { fieldNames } from '@/lib/forms/schemas';

/**
 * Registry mutations. Each one re-validates with the same Zod schema the browser used — the client
 * is not trusted — and returns an `ActionResult` rather than throwing, so the form can put the
 * server's complaint under the field that caused it.
 *
 * The `x-permission` on every one of these is re-checked by the Admin API; nothing here is a
 * security boundary.
 */

export async function createStoreAction(
  values: StoreCreateValues,
): Promise<ActionResult<AdminComponents['Store']>> {
  const parsed = storeCreateSchema.safeParse(values);
  if (!parsed.success) {
    return { status: 'error', fieldErrors: {}, formError: 'Some fields are not valid.' };
  }
  const result = await createStore(compact(parsed.data));
  if (result.ok) revalidatePath('/stores');
  return toActionResult(result, fieldNames(storeCreateSchema));
}

export async function updateStoreAction(
  storeId: string,
  values: StoreUpdateValues,
): Promise<ActionResult<AdminComponents['Store']>> {
  const parsed = storeUpdateSchema.safeParse(values);
  if (!parsed.success) {
    return { status: 'error', fieldErrors: {}, formError: 'Some fields are not valid.' };
  }
  const result = await updateStore(storeId, compact(parsed.data));
  if (result.ok) {
    revalidatePath('/stores');
    revalidatePath(`/stores/${storeId}`);
  }
  return toActionResult(result, fieldNames(storeUpdateSchema));
}

export async function addDomainAction(
  storeId: string,
  values: DomainCreateValues,
): Promise<ActionResult<AdminComponents['Domain']>> {
  const parsed = domainCreateSchema.safeParse(values);
  if (!parsed.success) {
    return { status: 'error', fieldErrors: {}, formError: 'Some fields are not valid.' };
  }
  const result = await addDomain(storeId, compact(parsed.data));
  if (result.ok) revalidatePath(`/stores/${storeId}`);
  return toActionResult(result, fieldNames(domainCreateSchema));
}

export async function createSalesChannelAction(
  storeId: string,
  values: SalesChannelCreateValues,
): Promise<ActionResult<AdminComponents['SalesChannel']>> {
  const parsed = salesChannelCreateSchema.safeParse(values);
  if (!parsed.success) {
    return { status: 'error', fieldErrors: {}, formError: 'Some fields are not valid.' };
  }
  const result = await createSalesChannel(storeId, parsed.data);
  if (result.ok) revalidatePath(`/stores/${storeId}`);
  return toActionResult(result, fieldNames(salesChannelCreateSchema));
}

/**
 * The plain key comes back exactly once. It is returned to the caller and never written anywhere
 * else — not revalidated into a cache, not logged. The screen shows it and then it is gone.
 */
export async function createApiKeyAction(
  storeId: string,
  values: ApiKeyCreateValues,
): Promise<ActionResult<AdminComponents['ApiKey'] & { key: string }>> {
  const parsed = apiKeyCreateSchema.safeParse(values);
  if (!parsed.success) {
    return { status: 'error', fieldErrors: {}, formError: 'Some fields are not valid.' };
  }
  const { sales_channel_id: salesChannelId, ...rest } = parsed.data;
  const result = await createApiKey(storeId, {
    ...rest,
    // An empty select means "not scoped to a channel", which the contract expresses by omission.
    ...(salesChannelId === undefined || salesChannelId === ''
      ? {}
      : { sales_channel_id: salesChannelId }),
  });
  if (result.ok) revalidatePath(`/stores/${storeId}`);
  return toActionResult(result, fieldNames(apiKeyCreateSchema));
}
