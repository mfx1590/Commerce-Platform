// Pure rules of the account's self-service (#470). A plain module: it is imported by the server actions AND by
// the client forms, and a constant exported from a `'use client'` module would reach a server component as a
// client reference (the Next.js gotcha in Memory-main).
import type { Body } from '@/lib/store-api';

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
