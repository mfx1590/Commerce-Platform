/**
 * Rendering a customer's address, and deciding what a reader is told when there is none.
 *
 * `Address` is one of the PII records `src/lib/client-safe.ts` polices, so the panel that shows
 * these is a **server** component and no projection of an address crosses to the browser. This
 * module is the formatting half: pure, so the ordering and the omissions are testable without a
 * DOM and without going near the API.
 *
 * Pure: no `next/*`, no I/O, no React.
 */

import type { AdminComponents } from '../api/admin-client';

type Address = AdminComponents['Address'];

/** What `listCustomerAddresses` returns: an `Address` plus its id and the two default flags. */
export type CustomerAddress = Address & {
  id: string;
  is_default_shipping: boolean;
  is_default_billing: boolean;
};

const text = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * The address as a reader would write it on an envelope, blank parts omitted.
 *
 * Postal order is deliberately the contract's own fields in their conventional order rather than
 * anything locale-aware: a wrong guess at local convention reads worse than a plain list, and the
 * admin has no per-country address format to work from.
 */
export function addressLines(address: CustomerAddress): string[] {
  const name = [text(address.first_name), text(address.last_name)]
    .filter((part): part is string => part !== null)
    .join(' ');
  const cityLine = [text(address.city), text(address.region), text(address.postal_code)]
    .filter((part): part is string => part !== null)
    .join(' ');
  return [
    text(name),
    text(address.company),
    text(address.line1),
    text(address.line2),
    text(cityLine),
    text(address.country),
  ].filter((line): line is string => line !== null);
}

/** "Default shipping", "Default billing", both, or nothing — never a bare boolean. */
export function defaultLabels(address: CustomerAddress): string[] {
  const labels: string[] = [];
  if (address.is_default_shipping) labels.push('Default shipping');
  if (address.is_default_billing) labels.push('Default billing');
  return labels;
}

/**
 * The customer's own phone is on the customer record; an address may carry a different one (a
 * delivery contact). It is rendered separately and labelled, so nobody reads it as the customer's.
 */
export const addressPhone = (address: CustomerAddress): string | null => text(address.phone);

/**
 * Addresses sorted the way a reader wants them: the defaults first (shipping, then billing), the
 * rest in the order the API gave them, which is the customer's own order.
 */
export function sortAddresses(addresses: readonly CustomerAddress[]): CustomerAddress[] {
  const rank = (address: CustomerAddress) =>
    address.is_default_shipping ? 0 : address.is_default_billing ? 1 : 2;
  return [...addresses].sort((a, b) => rank(a) - rank(b));
}
