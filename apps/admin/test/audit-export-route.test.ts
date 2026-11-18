/**
 * The audit CSV route's own gate (#896 Fable review).
 *
 * A route handler is not a screen. The section guard that hides `/audit` from a non-owner does
 * nothing for a URL typed into the address bar, and `listAuditLog` is only `viewer` on a store —
 * so before this gate existed, a store-scoped staff user could have downloaded their stores' whole
 * audit log as a file. These tests are the thing that keeps the handler and the page agreeing, and
 * they assert the Admin API is **not reached** when the caller is refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { principals, SEED, type PrincipalKey } from './fixtures/principals';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/roles', () => ({ isServiceAccount: () => false }));

const principalOf = vi.hoisted(() => ({
  current: 'owner' as string,
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

const api = vi.hoisted(() => ({
  listAuditLog: vi.fn(),
  listUsers: vi.fn(),
  listStores: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const { GET } = await import('@/app/(hq)/audit/export/route');

const ok = <T>(data: T) => ({ ok: true as const, status: 200, data });
const page = <T>(items: T[]) => ok({ page: 1, limit: 50, total: items.length, items });

const entry = {
  id: '90000000-0000-4000-8000-000000000001',
  store_id: SEED.stores.brandA,
  actor_id: SEED.users.storeAdmin,
  actor_type: 'staff',
  action: 'product.update',
  entity_type: 'product',
  entity_id: '30000000-0000-4000-8000-000000000201',
  before: { title: 'Classic T' },
  after: { title: 'Classic Tee' },
  request_id: 'req_abc',
  created_at: '2026-11-13T12:00:00.000Z',
};

const get = (search = '') => GET(new Request(`http://admin.test/audit/export${search}`));

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'owner';
  principalOf.failure = null;
  api.listAuditLog.mockResolvedValue(page([entry]));
  api.listStores.mockResolvedValue(
    page([{ id: SEED.stores.brandA, name: 'Brand A', code: 'brand-a' }]),
  );
  api.listUsers.mockResolvedValue(page([]));
});

describe('the gate', () => {
  it('401 without a session, and the Admin API is never called', async () => {
    principalOf.failure = { status: 401 };
    const response = await get();
    expect(response.status).toBe(401);
    expect(api.listAuditLog).not.toHaveBeenCalled();
  });

  it('forwards a failed /admin/me rather than deciding for itself (503 stays 503)', async () => {
    // A fail-closed OpenFGA answers 503. Treating that as "no relation" would be a 403 the owner
    // cannot act on; treating it as fine would be worse.
    principalOf.failure = { status: 503 };
    const response = await get();
    expect(response.status).toBe(503);
    expect(api.listAuditLog).not.toHaveBeenCalled();
  });

  it('403 for a store-scoped user, who is exactly who the API alone would have served', async () => {
    principalOf.current = 'storeAdmin';
    const response = await get();
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string; details?: { relation?: string } };
    expect(body.code).toBe('forbidden');
    expect(body.details?.relation).toBe('owner');
    expect(api.listAuditLog).not.toHaveBeenCalled();
  });

  it.each(['finance', 'operations', 'analyst', 'support', 'storeStaff', 'unassigned'] as const)(
    '403 for %s',
    async (key) => {
      principalOf.current = key;
      expect((await get()).status).toBe(403);
      expect(api.listAuditLog).not.toHaveBeenCalled();
    },
  );
});

describe('past the gate', () => {
  it('an owner gets a CSV attachment', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="audit-all-page1-/,
    );
    expect(response.headers.get('cache-control')).toBe('no-store');

    const csv = await response.text();
    expect(csv.split('\r\n')[0]).toBe(
      'time,store,actor,actor_type,action,entity_type,entity_id,summary,changed_fields,request_id',
    );
    expect(csv).toContain('updated · title');
    expect(csv).toContain('Brand A (brand-a)');
  });

  it('names the file after the filters and sends the filters on', async () => {
    const response = await get('?entity_type=product&from=2026-11-01');
    expect(response.headers.get('content-disposition')).toMatch(/audit-filtered-page1-/);
    expect(api.listAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'product',
        from: '2026-11-01T00:00:00.000Z',
      }),
    );
  });

  it("forwards the API's refusal with its status, not an empty file", async () => {
    api.listAuditLog.mockResolvedValue({
      ok: false as const,
      status: 403,
      error: { code: 'forbidden', message: 'Forbidden' },
    });
    const response = await get();
    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

  it('an unreachable API is a 502, not a 0', async () => {
    api.listAuditLog.mockResolvedValue({
      ok: false as const,
      status: 0,
      error: { code: 'unavailable', message: 'no answer' },
    });
    expect((await get()).status).toBe(502);
  });
});
