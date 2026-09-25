/**
 * The customers wrappers and actions against the spec's own examples (Admin API 0.4.5). Prism is
 * spawned here on its own port. The customers module in the core is Phase 3 (window 13), so this
 * suite is the only executable statement of what the screens read.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SEED_STORE_ID, preferring, startPrism, type PrismHandle } from './prism';

const BASE = 'http://127.0.0.1:4214';
let prism: PrismHandle | undefined;
process.env['ADMIN_API_URL'] = BASE;
process.env['MOCK_ADMIN_API_URL'] = BASE;

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/current-session', () => ({
  getSession: async () => ({ accessToken: 'contract-test-token' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const api = await import('@/lib/api/admin');
const { adminRequest } = await import('@/lib/api/admin-client');
const { toActionResult } = await import('@/lib/forms/action-result');
const actions = await import('@/app/actions/customers');
const { consentRows } = await import('@/lib/customers/consent');

const CUSTOMER_ID = '30000000-0000-4000-8000-000000000a01';

beforeAll(async () => {
  prism = await startPrism(BASE);
}, 60_000);

afterAll(() => prism?.stop());

describe('the wrappers reach the paths the spec documents', () => {
  it('lists customers with the contract sort and search', async () => {
    const result = await api.listCustomers(SEED_STORE_ID, {
      page: 1,
      limit: 20,
      sort: 'last_name',
      order: 'asc',
      q: 'jane',
    });
    if (!result.ok) throw new Error(`listCustomers failed: ${result.status}`);
    expect(result.data.items[0]).toMatchObject({
      email: expect.any(String),
      status: expect.any(String),
      consent: expect.any(Object),
    });
  });

  it('reads one customer, and the consent example is the documented shape', async () => {
    const result = await api.getCustomer(SEED_STORE_ID, CUSTOMER_ID);
    if (!result.ok) throw new Error(`getCustomer failed: ${result.status}`);
    const rows = consentRows(result.data.consent);
    expect(rows).toEqual([
      {
        channel: 'marketing_email',
        granted: true,
        at: '2026-09-04T10:00:00Z',
        source: 'checkout',
        raw: null,
      },
    ]);
  });

  it('updates a customer (200 with the record)', async () => {
    const result = await api.updateCustomer(SEED_STORE_ID, CUSTOMER_ID, {
      first_name: 'Jane',
      status: 'disabled',
    });
    if (!result.ok) throw new Error(`updateCustomer failed: ${result.status}`);
    expect(result.data).toMatchObject({ id: expect.any(String), email: expect.any(String) });
  });

  it('erases with a 202 and no body — ok, data null', async () => {
    const result = await api.eraseCustomer(SEED_STORE_ID, CUSTOMER_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.status).toBe(202);
    expect(result.data).toBeNull();
  });
});

describe('the server actions against the spec', () => {
  it('update: empty strings are not sent, an empty group id clears the group', async () => {
    const result = await actions.updateCustomerAction(SEED_STORE_ID, CUSTOMER_ID, {
      first_name: 'Jane',
      phone: '',
      customer_group_id: '',
    });
    expect(result.status).toBe('success');
  });

  it('erase: the bodiless 202 is a success with null data', async () => {
    const result = await actions.eraseCustomerAction(SEED_STORE_ID, CUSTOMER_ID);
    expect(result).toEqual({ status: 'success', data: null });
  });
});

describe("the spec's documented refusals on the customer operations", () => {
  it('403 on getCustomer (an analyst typing the URL) becomes a refusal for the panel', async () => {
    const result = await adminRequest<'getCustomer'>({
      baseUrl: BASE,
      path: `/admin/stores/${SEED_STORE_ID}/customers/${CUSTOMER_ID}`,
      accessToken: 'contract-test-token',
      headers: preferring(403),
    });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.status).toBe(403);
    expect(result.error.details).toMatchObject({
      relation: expect.any(String),
      object: expect.any(String),
    });
  });

  it('401 on updateCustomer is a refusal with no field error', async () => {
    const result = await adminRequest<'updateCustomer'>({
      baseUrl: BASE,
      path: `/admin/stores/${SEED_STORE_ID}/customers/${CUSTOMER_ID}`,
      method: 'PATCH',
      body: { first_name: 'x' },
      accessToken: 'contract-test-token',
      headers: preferring(401),
    });
    if (result.ok) throw new Error('expected a refusal');
    const mapped = toActionResult(result, ['first_name']);
    if (mapped.status !== 'error') throw new Error('expected error');
    expect(mapped.refusal?.status).toBe(401);
    expect(mapped.fieldErrors).toEqual({});
  });

  it('403 on eraseCustomer (support, not store_admin) is a refusal too', async () => {
    const result = await adminRequest<'eraseCustomer'>({
      baseUrl: BASE,
      path: `/admin/stores/${SEED_STORE_ID}/customers/${CUSTOMER_ID}/erase`,
      method: 'POST',
      accessToken: 'contract-test-token',
      headers: preferring(403),
    });
    if (result.ok) throw new Error('expected a refusal');
    const mapped = toActionResult(result, []);
    if (mapped.status !== 'error') throw new Error('expected error');
    expect(mapped.refusal?.status).toBe(403);
  });
});
