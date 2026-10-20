'use server';

import { revalidatePath } from 'next/cache';
import { getAccessToken } from './auth/session';
import { parseAddressForm } from './checkout';
import { mapCheckoutError } from './checkout';
import { storeApi } from './store-api';

/**
 * Account mutations. Like the checkout actions these run on the server with the typed client; the
 * customer's bearer token never reaches the browser, and the client itself refuses to attach it to
 * anything outside `/store/customers/*` and `/store/orders/{id}`.
 */

export interface AccountActionState {
  error?: string;
  ok?: boolean;
  fieldErrors?: Record<string, string>;
}

function field(formData: FormData, name: string): string | undefined {
  const raw = formData.get(name);
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export async function updateProfileAction(
  _previous: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const token = await getAccessToken();
  if (token === null) return { error: 'Your session has expired. Please sign in again.' };

  // Read once into consts: re-calling `field()` inside the spread keeps the type `string | undefined`
  // and `exactOptionalPropertyTypes` then rejects it.
  const firstName = field(formData, 'first_name');
  const lastName = field(formData, 'last_name');
  const phone = field(formData, 'phone');

  const body = {
    ...(firstName === undefined ? {} : { first_name: firstName }),
    ...(lastName === undefined ? {} : { last_name: lastName }),
    ...(phone === undefined ? {} : { phone }),
    marketing_consent: formData.get('marketing_consent') === 'on',
  };

  try {
    await storeApi().updateMe(body, { token });
  } catch (error) {
    return { error: mapCheckoutError(error).message };
  }
  revalidatePath('/account');
  return { ok: true };
}

export async function addAddressAction(
  _previous: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const token = await getAccessToken();
  if (token === null) return { error: 'Your session has expired. Please sign in again.' };

  // The address form is the checkout's, minus the email: reuse its validation rather than a second
  // copy that could drift from the contract's Address shape.
  const parsed = parseAddressForm(formData, { requireEmail: false });
  if (parsed.address === undefined) {
    return { error: 'Please correct the highlighted fields.', fieldErrors: parsed.errors };
  }

  try {
    await storeApi().addMyAddress(parsed.address, { token });
  } catch (error) {
    return { error: mapCheckoutError(error).message };
  }
  revalidatePath('/account');
  return { ok: true };
}
