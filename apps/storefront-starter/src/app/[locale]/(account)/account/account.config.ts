// Pure rules of the account's self-service (#470). A plain module: it is imported by the server actions AND by
// the client forms, and a constant exported from a `'use client'` module would reach a server component as a
// client reference (the Next.js gotcha in Memory-main).
import type { Body } from '@/lib/store-api';

/**
 * The privacy-policy version this storefront shows (#471): sent with every consent answer, so the ledger records
 * the version the customer SAW. Set `PRIVACY_POLICY_VERSION` in the environment when the policy changes; it
 * should match the store's `settings.privacy.policy_version` (what the one-checkbox profile shortcut records).
 * Server only — the page reads it and passes it down.
 */
export function privacyPolicyVersion(): string {
  const v = process.env.PRIVACY_POLICY_VERSION?.trim();
  return v === undefined || v === '' ? 'unversioned' : v;
}

/** What the exports panel says about one export (#472 / #501 review nit: the rule is pure, so it is tested). */
export function exportStatus(item: {
  status: 'pending' | 'ready' | 'expired';
  reason: 'customer_gone' | 'too_large' | null;
  expires_at: string | null;
}): { key: 'until' | 'pending' | 'tooLarge' | 'expired'; date: string | null } {
  if (item.status === 'ready') return { key: 'until', date: item.expires_at };
  if (item.status === 'pending') return { key: 'pending', date: null };
  return { key: item.reason === 'too_large' ? 'tooLarge' : 'expired', date: null };
}

/** The download path of one export, under the locale the customer is browsing (#501 review nit). */
export function exportDownloadPath(locale: string, exportId: string): string {
  return `/${locale}/account/exports/${exportId}`;
}

/** The purposes the consents form shows, in order (the Store API's closed set). */
export const CONSENT_PURPOSES = ['marketing_email'] as const;

/** What the customer must type to delete their account — compared exactly, no trimming of the inside. */
export const DELETE_CONFIRMATION = 'DELETE';

export function isDeleteConfirmed(input: FormDataEntryValue | null): boolean {
  return typeof input === 'string' && input.trim() === DELETE_CONFIRMATION;
}

export type AddressPatch = Body<'updateMyAddress'>;

const REQUIRED = ['first_name', 'last_name', 'line1', 'city', 'postal_code', 'country'] as const;
const OPTIONAL = ['company', 'line2', 'region', 'phone'] as const;
const LABELS: Record<(typeof REQUIRED)[number], string> = {
  first_name: 'First name',
  last_name: 'Last name',
  line1: 'Address',
  city: 'City',
  postal_code: 'Postal code',
  country: 'Country',
};

/**
 * The edit form sends every field (it is pre-filled), so the patch carries them all: a required field that is
 * blank is a field error here (the API would answer 400 naming it); an optional one that is blank becomes
 * `null`, which is how the customer clears it. The default checkbox is only sent as `true` — unticking a
 * default is not "give it up" (the API hands the flag to the oldest other address, which is rarely what
 * a customer means); the way to move a default is to tick it on another address.
 */
export function addressPatchFromForm(formData: FormData): {
  patch?: AddressPatch;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  const text = (name: string): string => {
    const raw = formData.get(name);
    return typeof raw === 'string' ? raw.trim() : '';
  };
  const patch: AddressPatch = {};
  for (const field of REQUIRED) {
    const v = text(field);
    if (v === '') errors[field] = `${LABELS[field]} is required`;
    else patch[field] = field === 'country' ? v.toUpperCase() : v;
  }
  if (patch.country !== undefined && !/^[A-Z]{2}$/.test(patch.country)) {
    errors.country = 'Use the two-letter country code, e.g. NL';
  }
  for (const field of OPTIONAL) {
    const v = text(field);
    patch[field] = v === '' ? null : v;
  }
  if (formData.get('is_default_shipping') === 'on') patch.is_default_shipping = true;
  if (formData.get('is_default_billing') === 'on') patch.is_default_billing = true;
  if (Object.keys(errors).length > 0) return { errors };
  return { patch, errors: {} };
}
