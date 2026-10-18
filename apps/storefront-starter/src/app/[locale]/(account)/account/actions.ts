'use server';

import { revalidatePath } from 'next/cache';
import { clearSession, getAccessToken } from '@/lib/auth/session';
import { mapCheckoutError } from '@/lib/checkout';
import { redirectLocalized } from '@/lib/navigate';
import { storeApi, type Result } from '@/lib/store-api';
import { addressPatchFromForm, isDeleteConfirmed } from './account.config';

/**
 * Account self-service mutations (#470, Store API 0.5.6): edit / remove an address, request my export, delete
 * my account. Same shape as `src/lib/account-actions.ts` (profile and add-address): on the server, with the
 * typed client, the customer's bearer token never in the browser. The four operations go through the client's
 * generic `request` — the client's typed methods are window 3's file; its `allowsCustomerToken` already admits
 * every `/store/customers/*` path. `redirect` only after the network call (it signals by throwing).
 */

export interface AccountActionState {
  error?: string;
  ok?: boolean;
  fieldErrors?: Record<string, string>;
}

const EXPIRED: AccountActionState = { error: 'Your session has expired. Please sign in again.' };

export async function updateAddressAction(
  addressId: string,
  _previous: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const token = await getAccessToken();
  if (token === null) return EXPIRED;
  const parsed = addressPatchFromForm(formData);
  if (parsed.patch === undefined) {
    return { error: 'Please correct the highlighted fields.', fieldErrors: parsed.errors };
  }
  try {
    await storeApi().request<Result<'updateMyAddress'>>(
      'PATCH',
      `/store/customers/me/addresses/${encodeURIComponent(addressId)}`,
      { body: parsed.patch, options: { token } },
    );
  } catch (error) {
    return { error: mapCheckoutError(error).message };
  }
  revalidatePath('/account');
  return { ok: true };
}

export async function deleteAddressAction(
  addressId: string,
  _previous: AccountActionState,
  _formData: FormData,
): Promise<AccountActionState> {
  const token = await getAccessToken();
  if (token === null) return EXPIRED;
  try {
    await storeApi().request<Result<'deleteMyAddress'>>(
      'DELETE',
      `/store/customers/me/addresses/${encodeURIComponent(addressId)}`,
      { options: { token } },
    );
  } catch (error) {
    return { error: mapCheckoutError(error).message };
  }
  revalidatePath('/account');
  return { ok: true };
}

export async function requestExportAction(
  _previous: AccountActionState,
  _formData: FormData,
): Promise<AccountActionState> {
  const token = await getAccessToken();
  if (token === null) return EXPIRED;
  try {
    await storeApi().request<void>('POST', '/store/customers/me/export', { options: { token } });
  } catch (error) {
    return { error: mapCheckoutError(error).message };
  }
  return { ok: true };
}

export async function deleteAccountAction(
  _previous: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const token = await getAccessToken();
  if (token === null) return EXPIRED;
  if (!isDeleteConfirmed(formData.get('confirmation'))) {
    return {
      error: 'Please confirm the deletion.',
      fieldErrors: { confirmation: 'Type the word exactly as shown to confirm' },
    };
  }
  try {
    await storeApi().request<void>('DELETE', '/store/customers/me', { options: { token } });
  } catch (error) {
    return { error: mapCheckoutError(error).message };
  }
  // The account is gone here; the local session goes with it. Keycloak's own SSO session is ended from
  // the goodbye page (`/auth/sign-out` is a POST, not something a redirect can do).
  await clearSession();
  return redirectLocalized('/account/deleted');
}
