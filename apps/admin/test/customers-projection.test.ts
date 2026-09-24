import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AdminComponents } from '@/lib/api/admin-client';
import {
  CUSTOMER_PII_KEYS,
  forCustomerRow,
  forCustomerRows,
  type CustomerRow,
} from '@/lib/customers/projection';

type Customer = AdminComponents['Customer'];

const customer: Customer = {
  id: '30000000-0000-4000-8000-000000000a01',
  identity_id: '30000000-0000-4000-8000-000000000b01',
  email: 'jane@example.com',
  first_name: 'Jane',
  last_name: 'Doe',
  phone: '+31 20 000 0000',
  customer_group_id: null,
  status: 'registered',
  consent: { marketing_email: { granted: true, at: '2026-09-04T10:00:00Z', source: 'checkout' } },
  created_at: '2026-09-04T10:00:00Z',
};

/**
 * The #268 review finding, pinned: the customers list handed the full record to the client
 * table, so every listed customer's phone, identity id and raw consent crossed the wire.
 */
describe('customer row projection for the list table', () => {
  it('carries exactly the columns the table renders, with the consent precomputed', () => {
    const row = forCustomerRow(customer);
    expect(Object.keys(row).sort()).toEqual(
      [
        'id',
        'email',
        'first_name',
        'last_name',
        'status',
        'consent_summary',
        'customer_group_id',
        'created_at',
      ].sort(),
    );
    expect(row.consent_summary).toBe('1 of 1 channel');
  });

  it('never carries the phone, the identity id or the consent channels — as keys or as values', () => {
    const rows = forCustomerRows([customer]);
    const wire = JSON.stringify(rows);
    for (const key of CUSTOMER_PII_KEYS) expect(rows[0]).not.toHaveProperty(key);
    expect(wire).not.toContain(customer.phone ?? 'never');
    expect(wire).not.toContain(customer.identity_id ?? 'never');
    expect(wire).not.toContain('marketing_email');
    expect(wire).not.toContain('checkout');
  });

  it('the full Customer does not typecheck as a row; only the projection does', () => {
    expectTypeOf<Customer>().not.toMatchTypeOf<CustomerRow>();
    expectTypeOf<Customer[]>().not.toMatchTypeOf<CustomerRow[]>();
    expectTypeOf(forCustomerRow(customer)).toMatchTypeOf<CustomerRow>();
  });
});
