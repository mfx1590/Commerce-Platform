/**
 * What a customer looks like once it may cross to a client component (`src/lib/client-safe.ts`).
 *
 * The list table renders email, name, status, a consent summary, the group id and the date — so
 * that is all a row carries. `phone`, `identity_id` and the raw `consent` object stay on the
 * server (the #268 review found them in the Flight payload). The consent summary is computed
 * here so the client never sees the channels themselves.
 */

import type { AdminComponents } from '../api/admin-client';
import { markClientSafe, type ClientSafe } from '../client-safe';
import { consentSummary } from './consent';

type Customer = AdminComponents['Customer'];

export type CustomerRow = ClientSafe<{
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: Customer['status'];
  /** "1 of 2 channels" — precomputed; the channels never leave the server. */
  consent_summary: string;
  customer_group_id: string | null;
  created_at: string;
}>;

export function forCustomerRow(customer: Customer): CustomerRow {
  return markClientSafe({
    id: customer.id,
    email: customer.email,
    first_name: customer.first_name,
    last_name: customer.last_name,
    status: customer.status,
    consent_summary: consentSummary(customer.consent),
    customer_group_id: customer.customer_group_id,
    created_at: customer.created_at,
  });
}

export const forCustomerRows = (customers: readonly Customer[]): CustomerRow[] =>
  customers.map(forCustomerRow);

/** Never on the wire for the list. */
export const CUSTOMER_PII_KEYS = ['phone', 'identity_id', 'consent'] as const;
