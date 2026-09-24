import type { TableQueryDefaults } from '@/lib/table/query-state';

/** Plain module (no `'use client'`) — imported by the server page as well as the client table. */

/** `listCustomers` in Admin API 0.4.5 sorts by exactly these. */
export const CUSTOMERS_SORTABLE_COLUMNS = ['created_at', 'email', 'last_name'] as const;

/** The contract's own filter parameters — anything else would be a 400. */
export const CUSTOMER_FILTER_KEYS = ['q', 'group_id'] as const;

export const CUSTOMERS_TABLE_DEFAULTS: TableQueryDefaults = { sort: 'created_at', order: 'desc' };

export type CustomerTone = 'neutral' | 'success' | 'warning' | 'danger';

/** `Customer.status` → pill tone; the name is always shown beside the tone. */
export const CUSTOMER_STATUS_TONES: Record<string, CustomerTone> = {
  guest: 'neutral',
  registered: 'success',
  disabled: 'warning',
  erased: 'danger',
};

export function customerTone(status: string): CustomerTone {
  return CUSTOMER_STATUS_TONES[status] ?? 'neutral';
}

/** "Jane Doe", or the email's local part when the name is not recorded. */
export function displayName(customer: {
  first_name: string | null;
  last_name: string | null;
  email: string;
}): string {
  const name = [customer.first_name, customer.last_name].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  return name.length > 0 ? name.join(' ') : (customer.email.split('@')[0] ?? customer.email);
}
