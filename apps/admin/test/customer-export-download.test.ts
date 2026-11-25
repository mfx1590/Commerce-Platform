/**
 * The bundle-download route (#870 item 4, after #962).
 *
 * This response is one person's entire record, so the tests are about what has to be true *before*
 * it is fetched, and about the handler never looking at what it hands over:
 *
 * - the gate runs in the handler, not in a guard component: a route handler is reachable by typing
 *   a URL, which is the #896 review's finding on `/audit/export`;
 * - every refusal happens **before** the fetch — asserted by the fetch never being called;
 * - 410 is a state ("expired, request a new export"), not a 500;
 * - the body is passed through untouched, as an attachment, and never cached.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { principals, SEED, type PrincipalKey } from './fixtures/principals';

vi.mock('server-only', () => ({}));

const principalOf = vi.hoisted(() => ({
  current: 'storeAdmin' as string,
  failure: null as { status: number } | null,
}));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () =>
    principalOf.failure !== null
      ? {
          ok: false as const,
          status: principalOf.failure.status,
          error: { code: 'unauthorized', message: 'No session' },
        }
      : {
          ok: true as const,
          status: 200,
          data: principals[principalOf.current as PrincipalKey],
        },
}));

const bundle = vi.hoisted(() => ({ fetchExportBundle: vi.fn() }));
vi.mock('@/lib/customers/bundle', () => bundle);

const { GET } =
  await import('@/app/(store)/[storeId]/customers/[customerId]/exports/[exportId]/route');

const STORE = SEED.stores.brandA;
const CUSTOMER = '50000000-0000-4000-8000-000000000001';
const EXPORT = '53000000-0000-4000-8000-000000000001';
const BODY = '{"profile":{"id":"50000000-0000-4000-8000-000000000001"},"orders":[]}';

const call = (over: Partial<Record<'storeId' | 'customerId' | 'exportId', string>> = {}) =>
  GET(new Request('http://admin.test/x'), {
    params: Promise.resolve({
      storeId: STORE,
      customerId: CUSTOMER,
      exportId: EXPORT,
      ...over,
    }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'storeAdmin';
  principalOf.failure = null;
  bundle.fetchExportBundle.mockResolvedValue({
    ok: true,
    status: 200,
    body: BODY,
    contentType: 'application/json',
  });
});

describe('the gate, before anything is fetched', () => {
  it('401 without a session, and the bundle is never requested', async () => {
    principalOf.failure = { status: 401 };
    const response = await call();
    expect(response.status).toBe(401);
    expect(bundle.fetchExportBundle).not.toHaveBeenCalled();
  });

  it('forwards a failed /admin/me as it is, so a fail-closed 503 stays a 503', async () => {
    principalOf.failure = { status: 503 };
    const response = await call();
    expect(response.status).toBe(503);
    expect(bundle.fetchExportBundle).not.toHaveBeenCalled();
  });

  it.each(['support', 'storeStaff', 'analyst', 'finance', 'operations', 'unassigned'] as const)(
    '403 for %s — store_admin is the relation, and nothing is fetched',
    async (key) => {
      principalOf.current = key;
      const response = await call();
      expect(response.status).toBe(403);
      const body = (await response.json()) as { details?: { relation?: string } };
      expect(body.details?.relation).toBe('store_admin');
      expect(bundle.fetchExportBundle).not.toHaveBeenCalled();
    },
  );

  it('403 for a store admin of ANOTHER store, not just any store admin', async () => {
    // The storeAdmin fixture holds brand-a and brand-b, never brand-c.
    principalOf.current = 'storeAdmin';
    const response = await call({ storeId: SEED.stores.brandC });
    expect(response.status).toBe(403);
    expect(bundle.fetchExportBundle).not.toHaveBeenCalled();
  });

  it('refuses a path that is not three uuids before touching the principal', async () => {
    const response = await call({ exportId: 'not-a-uuid' });
    expect(response.status).toBe(400);
    expect(bundle.fetchExportBundle).not.toHaveBeenCalled();
  });
});

describe('handing the bundle over', () => {
  it('streams it as an attachment, untouched and uncached', async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="customer-export-${EXPORT}.json"`,
    );
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    // Byte-for-byte what the API gave: the handler is a conduit, not a reader.
    expect(await response.text()).toBe(BODY);
    expect(bundle.fetchExportBundle).toHaveBeenCalledWith(STORE, CUSTOMER, EXPORT);
  });

  it('410 is an expired state with a code the panel can read, not a failure', async () => {
    bundle.fetchExportBundle.mockResolvedValue({
      ok: false,
      status: 410,
      body: '{"code":"gone"}',
      contentType: 'application/json',
    });
    const response = await call();
    expect(response.status).toBe(410);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe('export_expired');
    expect(body.message).toMatch(/Request a new export/);
  });

  it('maps a 404 to our own message, and the upstream text does not cross (#965 review)', async () => {
    // The first version forwarded the API's body and content-type. On a route whose success case
    // is one person's whole record, nothing unexamined may be echoed to the browser.
    const upstream = '<html><body>nginx: no such export</body></html>';
    bundle.fetchExportBundle.mockResolvedValue({
      ok: false,
      status: 404,
      body: upstream,
      contentType: 'text/html',
    });
    const response = await call();
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const text = await response.text();
    expect(text).not.toContain('nginx');
    expect(text).not.toContain('<html>');
    expect(JSON.parse(text)).toEqual({
      code: 'not_found',
      message: 'That export does not exist.',
    });
  });

  it('keeps the status but not the body for a 401 or 403 from the API', async () => {
    for (const status of [401, 403]) {
      bundle.fetchExportBundle.mockResolvedValue({
        ok: false,
        status,
        body: '{"code":"whatever","message":"upstream wording"}',
        contentType: 'application/json',
      });
      const response = await call();
      expect(response.status).toBe(status);
      const body = (await response.json()) as { code: string; message: string };
      expect(body.code).toBe('forbidden');
      expect(body.message).not.toContain('upstream wording');
    }
  });

  it('every other failure, including an unreachable API, is 502 unavailable', async () => {
    // `fetchExportBundle` answers 503 when it cannot reach the API at all; 500 and anything
    // unexpected land in the same place. There is no `status === 0` path: the module never returns
    // one, and the dead branch that checked for it is gone (#965 review).
    for (const status of [500, 503, 418]) {
      bundle.fetchExportBundle.mockResolvedValue({
        ok: false,
        status,
        body: 'anything at all',
        contentType: 'text/plain',
      });
      const response = await call();
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain('anything at all');
    }
  });
});
