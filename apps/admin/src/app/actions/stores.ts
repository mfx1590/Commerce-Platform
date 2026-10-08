'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  activateStore,
  addDomain,
  createApiKey,
  createSalesChannel,
  createStore,
  onboardStore,
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
import {
  activationMessage,
  readMissing,
  toOnboardingInput,
  type OnboardingValues,
  onboardingSchema,
} from '@/lib/onboarding';
import type { ApiResult } from '@/lib/api/admin-client';

/**
 * Registry mutations. Each one re-validates with the same Zod schema the browser used — the client
 * is not trusted — and returns an `ActionResult` rather than throwing, so the form can put the
 * server's complaint under the field that caused it.
 *
 * Each one first refuses, server-side, unless the principal holds the operation's `x-permission`
 * (`refuseUnlessPermitted`, from `REGISTRY_PERMISSIONS`) — a server action is reachable by a
 * crafted POST whatever the page offered. The Admin API re-checks every one of them.
 */

/**
 * A store that cannot become active (#420): `updateStore` with `status: active` and `activateStore`
 * both answer 409 `ActivationBlocked` — `details.missing` (closed list) or `details.status:
 * archived`. Said in words under the status field, with the list for the readiness panel; the form
 * stays editable. Null for any other result.
 */
function activationBlocked<T>(result: ApiResult<T>): ActionResult<never> | null {
  if (result.ok || result.status !== 409) return null;
  const details = result.error.details;
  if (details === undefined || (!('missing' in details) && details['status'] !== 'archived')) {
    return null;
  }
  const message = activationMessage(details);
  return {
    status: 'error',
    fieldErrors: { status: message },
    formError: message,
    missing: readMissing(details),
  };
}

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
  // HQ (owner): status → active is activation, the contract's own operation (#420); the other
  // fields are saved first, so a blocked activation never loses them.
  const { status, ...fields } = compact(parsed.data);
  const activating = status === 'active';
  const result = await updateStore(storeId, activating ? fields : compact(parsed.data));
  if (!result.ok)
    return activationBlocked(result) ?? toActionResult(result, fieldNames(storeUpdateSchema));
  const final = activating ? await activateStore(storeId) : result;
  revalidatePath('/stores');
  revalidateStore(storeId);
  if (!final.ok)
    return activationBlocked(final) ?? toActionResult(final, fieldNames(storeUpdateSchema));
  return { status: 'success', data: final.data };
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
  // A store_admin cannot call activateStore (owner on hq): the core runs the same readiness check on
  // `updateStore` and answers the same 409, said here in words (#420).
  return activationBlocked(result) ?? toActionResult(result, fieldNames(storeSettingsSchema));
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

/** What the wizard gets back: the onboarded records, and the key exactly once (201) or null (200). */
export interface OnboardingOutcome {
  repeat: boolean;
  storeId: string;
  storeCode: string;
  /** The plain publishable key — present only on the 201, never stored, never logged. */
  key: string | null;
  keyPrefix: string | null;
}

/** The onboarding result, with the 400/409/422 `details` the wizard maps onto its steps. */
export type OnboardResult =
  | { status: 'success'; data: OnboardingOutcome }
  | (Extract<ActionResult<never>, { status: 'error' }> & {
      details?: Record<string, unknown> | undefined;
    });

/**
 * `onboardStore` (owner on hq): one transaction. The plain key comes back once, on the 201; it is
 * returned to the caller and written nowhere else — not revalidated into a cache, not logged. A 200
 * is the identical repeat: the store exists, no key. 409/422 come back with their `details` so the
 * wizard can send the reader to the step that owns the field.
 */
export async function onboardStoreAction(values: OnboardingValues): Promise<OnboardResult> {
  const refused = await refuseUnlessPermitted('onboardStore', '');
  if (refused !== null) return refused as OnboardResult;
  const parsed = onboardingSchema.safeParse(values);
  if (!parsed.success) {
    return { status: 'error', fieldErrors: {}, formError: 'Some fields are not valid.' };
  }
  const result = await onboardStore(toOnboardingInput(parsed.data));
  if (!result.ok) {
    const mapped = toActionResult(result, []) as Extract<ActionResult<never>, { status: 'error' }>;
    return { ...mapped, details: result.error.details };
  }
  revalidatePath('/stores');
  const key = result.data.publishable_key;
  return {
    status: 'success',
    data: {
      repeat: key === null,
      storeId: result.data.store.id,
      storeCode: result.data.store.code,
      key: key === null ? null : key.key,
      keyPrefix: key === null ? null : key.key_prefix,
    },
  };
}

/** `activateStore` (owner on hq): 200 with the store; 409 → the missing prerequisites in words. */
export async function activateStoreAction(
  storeId: string,
): Promise<ActionResult<AdminComponents['Store']>> {
  const refused = await refuseUnlessPermitted('activateStore', storeId);
  if (refused !== null) return refused;
  const result = await activateStore(storeId);
  if (result.ok) {
    revalidatePath('/stores');
    revalidateStore(storeId);
    return { status: 'success', data: result.data };
  }
  return activationBlocked(result) ?? toActionResult(result, []);
}
