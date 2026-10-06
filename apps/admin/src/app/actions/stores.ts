'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  addDomain,
  createApiKey,
  createSalesChannel,
  createStore,
  revokeApiKey,
  updateDomain,
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
  storeSettingsSchema,
  storeUpdateSchema,
  type ApiKeyCreateValues,
  type DomainCreateValues,
  type SalesChannelCreateValues,
  type StoreCreateValues,
  type StoreSettingsValues,
  type StoreUpdateValues,
} from '@/lib/forms/schemas';
import { fieldNames } from '@/lib/forms/schemas';
import { LAST_LIVE_KEY_MESSAGE, withDefault } from '@/lib/settings';
import { refuseUnlessPermitted } from '@/lib/permissions/guard';

/**
 * Registry mutations. Each one re-validates with the same Zod schema the browser used — the client
 * is not trusted — and returns an `ActionResult` rather than throwing, so the form can put the
 * server's complaint under the field that caused it.
 *
 * Each one first refuses, server-side, unless the principal holds the operation's `x-permission`
 * (`refuseUnlessPermitted`, from `REGISTRY_PERMISSIONS`) — a server action is reachable by a
 * crafted POST whatever the page offered. The Admin API re-checks every one of them.
 */

/** A registry change shows on the HQ store page and on the Store view's settings. */
function revalidateStore(storeId: string): void {
  revalidatePath(`/stores/${storeId}`);
  revalidatePath(`/${storeId}/settings`);
}

export async function createStoreAction(
  values: StoreCreateValues,
): Promise<ActionResult<AdminComponents['Store']>> {
  const refused = await refuseUnlessPermitted('createStore', '');
  if (refused !== null) return refused;
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
  const refused = await refuseUnlessPermitted('updateStore', storeId);
  if (refused !== null) return refused;
  const parsed = storeUpdateSchema.safeParse(values);
  if (!parsed.success) {
    return { status: 'error', fieldErrors: {}, formError: 'Some fields are not valid.' };
  }
  const result = await updateStore(storeId, compact(parsed.data));
  if (result.ok) {
    revalidatePath('/stores');
    revalidateStore(storeId);
  }
  return toActionResult(result, fieldNames(storeUpdateSchema));
}

/**
 * The Store view's General settings. Parsed with `storeSettingsSchema`, so a request edited in the
 * browser cannot reach the legal entity or the code — those are HQ's.
 */
export async function updateStoreSettingsAction(
  storeId: string,
  values: StoreSettingsValues,
): Promise<ActionResult<AdminComponents['Store']>> {
  const refused = await refuseUnlessPermitted('updateStore', storeId);
  if (refused !== null) return refused;
  const parsed = storeSettingsSchema.strict().safeParse(values);
  if (!parsed.success) {
    return { status: 'error', fieldErrors: {}, formError: 'Some fields are not valid.' };
  }
  const { currencies, locales, ...rest } = parsed.data;
  const result = await updateStore(storeId, {
    ...rest,
    currencies: withDefault(currencies, rest.default_currency),
    locales: withDefault(locales, rest.default_locale),
  });
  if (result.ok) {
    revalidatePath('/stores');
    revalidateStore(storeId);
  }
  return toActionResult(result, fieldNames(storeSettingsSchema));
}

export async function addDomainAction(
  storeId: string,
  values: DomainCreateValues,
): Promise<ActionResult<AdminComponents['Domain']>> {
  const refused = await refuseUnlessPermitted('addDomain', storeId);
  if (refused !== null) return refused;
  const parsed = domainCreateSchema.safeParse(values);
  if (!parsed.success) {
    return { status: 'error', fieldErrors: {}, formError: 'Some fields are not valid.' };
  }
  const result = await addDomain(storeId, compact(parsed.data));
  if (result.ok) revalidateStore(storeId);
  return toActionResult(result, fieldNames(domainCreateSchema));
}

export async function createSalesChannelAction(
  storeId: string,
  values: SalesChannelCreateValues,
): Promise<ActionResult<AdminComponents['SalesChannel']>> {
  const refused = await refuseUnlessPermitted('createSalesChannel', storeId);
  if (refused !== null) return refused;
  const parsed = salesChannelCreateSchema.safeParse(values);
  if (!parsed.success) {
    return { status: 'error', fieldErrors: {}, formError: 'Some fields are not valid.' };
  }
  const result = await createSalesChannel(storeId, parsed.data);
  if (result.ok) revalidateStore(storeId);
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
  const refused = await refuseUnlessPermitted('createApiKey', storeId);
  if (refused !== null) return refused;
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
  if (result.ok) revalidateStore(storeId);
  return toActionResult(result, fieldNames(apiKeyCreateSchema));
}

/**
 * `updateDomain { is_primary: true }` — moves the primary flag here; the core clears it on the
 * domain that had it. Only `true` is ever sent: a store always has one primary, so the flag moves
 * by choosing the new one, never by clearing the old (the spec refuses that with 409).
 */
export async function setPrimaryDomainAction(
  storeId: string,
  domainId: string,
): Promise<ActionResult<AdminComponents['Domain']>> {
  const refused = await refuseUnlessPermitted('updateDomain', storeId);
  if (refused !== null) return refused;
  if (!z.string().uuid().safeParse(domainId).success) {
    return { status: 'error', fieldErrors: {}, formError: 'That domain is not valid.' };
  }
  const result = await updateDomain(storeId, domainId, { is_primary: true });
  if (result.ok) revalidateStore(storeId);
  return toActionResult(result, []);
}

/**
 * `revokeApiKey`. The screen asks first and does not offer it on the last live publishable key;
 * the core refuses that one anyway (409 `last_live_key`), and the refusal is said in plain words.
 */
export async function revokeApiKeyAction(
  storeId: string,
  keyId: string,
): Promise<ActionResult<AdminComponents['ApiKey']>> {
  const refused = await refuseUnlessPermitted('revokeApiKey', storeId);
  if (refused !== null) return refused;
  if (!z.string().uuid().safeParse(keyId).success) {
    return { status: 'error', fieldErrors: {}, formError: 'That key is not valid.' };
  }
  const result = await revokeApiKey(storeId, keyId);
  if (result.ok) revalidateStore(storeId);
  if (!result.ok && result.status === 409 && result.error.code === 'last_live_key') {
    return { status: 'error', fieldErrors: {}, formError: LAST_LIVE_KEY_MESSAGE };
  }
  return toActionResult(result, []);
}
