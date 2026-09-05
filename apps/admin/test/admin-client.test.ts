import { describe, expect, it, vi } from 'vitest';
import type { AdminResponse } from '@/lib/api/admin-client';
import { adminRequest, buildPath } from '@/lib/api/admin-client';

const BASE = 'http://localhost:4011';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('buildPath', () => {
  it('substitutes and encodes path parameters', () => {
    expect(buildPath('/admin/stores/{storeId}/products', { storeId: 'a b' })).toEqual(
      '/admin/stores/a%20b/products',
    );
  });

  it('throws when a parameter is missing rather than calling a malformed URL', () => {
    expect(() => buildPath('/admin/stores/{storeId}')).toThrow(/storeId/);
  });
});

describe('adminRequest', () => {
  it('sends the bearer token and returns typed data on 200', async () => {
    const principal: AdminResponse<'getMe'> = {
      user: { id: 'u1', email: 'store-admin@example.com', display_name: 'Store Admin' },
      organization: { id: 'o1', slug: 'hq', name: 'HQ' },
      organization_relations: [],
      stores: [{ store_id: 's1', code: 'brand-a', name: 'Brand A', relations: ['store_admin'] }],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, principal));

    const result = await adminRequest<'getMe'>({
      baseUrl: BASE,
      path: '/admin/me',
      accessToken: 'token-123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true, status: 200, data: principal });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toEqual(`${BASE}/admin/me`);
    expect((init.headers as Record<string, string>)['authorization']).toEqual('Bearer token-123');
  });

  it('omits the authorization header when there is no session', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    await adminRequest<'getMe'>({
      baseUrl: BASE,
      path: '/admin/me',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('appends defined query parameters and drops undefined ones', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    await adminRequest<'listStores'>({
      baseUrl: BASE,
      path: '/admin/stores',
      query: { page: 2, limit: 20, q: undefined },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toEqual(`${BASE}/admin/stores?page=2&limit=20`);
  });

  it('maps a contract 403 body onto the failure branch instead of throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(403, {
        code: 'forbidden',
        message: 'requires finance on organization:hq',
        details: { relation: 'finance', object: 'organization:hq' },
      }),
    );

    const result = await adminRequest<'listLegalEntities'>({
      baseUrl: BASE,
      path: '/admin/legal-entities',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.status).toBe(403);
    expect(result.error.code).toEqual('forbidden');
    expect(result.error.details).toEqual({ relation: 'finance', object: 'organization:hq' });
  });

  it('maps a 401 body onto the failure branch', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(401, { code: 'unauthorized', message: 'Missing bearer token' }),
      );

    const result = await adminRequest<'getMe'>({
      baseUrl: BASE,
      path: '/admin/me',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ ok: false, status: 401, error: { code: 'unauthorized' } });
  });

  it('coerces a non-contract error body into an Error shape', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('<html>gateway</html>', { status: 502 }));

    const result = await adminRequest<'getMe'>({
      baseUrl: BASE,
      path: '/admin/me',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ ok: false, status: 502, error: { code: 'internal' } });
  });

  it('turns a transport failure into a network_error result', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

    const result = await adminRequest<'getMe'>({
      baseUrl: BASE,
      path: '/admin/me',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ ok: false, status: 0, error: { code: 'network_error' } });
  });

  it('serialises a JSON body and sets the content type', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { id: 's1' }));
    await adminRequest<'createStore'>({
      baseUrl: BASE,
      path: '/admin/stores',
      method: 'POST',
      body: { code: 'brand-d', name: 'Brand D' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toEqual('POST');
    expect((init.headers as Record<string, string>)['content-type']).toEqual('application/json');
    expect(init.body).toEqual(JSON.stringify({ code: 'brand-d', name: 'Brand D' }));
  });
});
