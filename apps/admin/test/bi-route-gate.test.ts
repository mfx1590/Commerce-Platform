/**
 * #900: every BI route handler checks the principal and the section predicate BEFORE any Admin API
 * call — HQ routes the HQ `bi` section (analyst on organization:hq), store routes the `bi` section of
 * the URL's store — the same pattern as the audit export (#896). Per route: 401 (and a forwarded
 * fail-closed status), 403, allowed. Mutation-checked: deleting any route's gate fails its 403 case.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED, type PrincipalKey } from './fixtures/principals';

vi.mock('server-only', () => ({}));

const principalOf = vi.hoisted(() => ({ current: 'analyst' as string | { status: number } }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => {
    const current = principalOf.current;
    if (typeof current !== 'string') {
      return {
        ok: false,
        status: current.status,
        error: { code: 'unauthorized', message: 'no session' },
      };
    }
    return {
      ok: true,
      status: 200,
      data: (await import('./fixtures/principals')).principals[current as PrincipalKey],
    };
  },
}));

const api = vi.hoisted(() => ({
  queryMetrics: vi.fn(),
  queryMetricsCsv: vi.fn(),
  askMetrics: vi.fn(),
  askMetricsFeedback: vi.fn(),
}));
vi.mock('@/app/(hq)/bi/_api', () => api);

const hq = {
  export: (await import('@/app/(hq)/bi/export/route')).GET,
  query: (await import('@/app/(hq)/bi/query/route')).POST,
  ask: (await import('@/app/(hq)/bi/ask/route')).POST,
  feedback: (await import('@/app/(hq)/bi/ask/[conversationId]/feedback/route')).POST,
  live: (await import('@/app/(hq)/bi/live/route')).GET,
};
const store = {
  export: (await import('@/app/(store)/[storeId]/bi/export/route')).GET,
  query: (await import('@/app/(store)/[storeId]/bi/query/route')).POST,
  ask: (await import('@/app/(store)/[storeId]/bi/ask/route')).POST,
  feedback: (await import('@/app/(store)/[storeId]/bi/ask/[conversationId]/feedback/route')).POST,
  live: (await import('@/app/(store)/[storeId]/bi/live/route')).GET,
};

const A = SEED.stores.brandA;
const C = SEED.stores.brandC;
const CONVERSATION = '70000000-0000-4000-8000-000000000001';

const post = (body: unknown) =>
  new Request('http://x/bi', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const get = () => new Request('http://x/bi?from=2026-11-01&to=2026-11-07');

interface RouteCase {
  name: string;
  call: (storeId?: string) => Promise<Response>;
}

const HQ_ROUTES: RouteCase[] = [
  { name: 'HQ export', call: () => hq.export(get()) },
  { name: 'HQ query', call: () => hq.query(post({ query: { metrics: ['orders'] } })) },
  { name: 'HQ ask', call: () => hq.ask(post({ question: 'How many orders?' })) },
  {
    name: 'HQ ask feedback',
    call: () =>
      hq.feedback(post({ rating: 'up' }), {
        params: Promise.resolve({ conversationId: CONVERSATION }),
      }),
  },
  { name: 'HQ live', call: () => hq.live() },
];

const STORE_ROUTES: RouteCase[] = [
  {
    name: 'store export',
    call: (s = A) => store.export(get(), { params: Promise.resolve({ storeId: s }) }),
  },
  {
    name: 'store query',
    call: (s = A) =>
      store.query(post({ query: { metrics: ['orders'] } }), {
        params: Promise.resolve({ storeId: s }),
      }),
  },
  {
    name: 'store ask',
    call: (s = A) =>
      store.ask(post({ question: 'How many orders?' }), {
        params: Promise.resolve({ storeId: s }),
      }),
  },
  {
    name: 'store ask feedback',
    call: (s = A) =>
      store.feedback(post({ rating: 'up' }), {
        params: Promise.resolve({ storeId: s, conversationId: CONVERSATION }),
      }),
  },
  {
    name: 'store live',
    call: (s = A) =>
      store.live(new Request('http://x'), { params: Promise.resolve({ storeId: s }) }),
  },
];

const apiCalls = () => Object.values(api).reduce((sum, fn) => sum + fn.mock.calls.length, 0);

beforeEach(() => {
  vi.clearAllMocks();
  api.queryMetrics.mockResolvedValue({ ok: true, status: 200, data: { rows: [] } });
  api.queryMetricsCsv.mockResolvedValue({ ok: true, csv: 'period\r\n', truncated: false });
  api.askMetrics.mockResolvedValue({ ok: true, status: 200, data: {} });
  api.askMetricsFeedback.mockResolvedValue({ ok: true, status: 204, data: null });
});

describe.each(HQ_ROUTES)('$name', ({ call }) => {
  it('401 without a session, and the API is never called', async () => {
    principalOf.current = { status: 401 };
    const res = await call();
    expect(res.status).toBe(401);
    expect(apiCalls()).toBe(0);
  });

  it('forwards a fail-closed /admin/me status (503 stays 503)', async () => {
    principalOf.current = { status: 503 };
    expect((await call()).status).toBe(503);
    expect(apiCalls()).toBe(0);
  });

  it.each<PrincipalKey>(['storeAdmin', 'storeStaff', 'support', 'finance'])(
    '403 for %s (no analyst on organization:hq), before any API call',
    async (who) => {
      principalOf.current = who;
      const res = await call();
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        code: 'forbidden',
        details: { relation: 'analyst', object: 'organization:hq' },
      });
      expect(apiCalls()).toBe(0);
    },
  );

  it('an analyst reaches the API', async () => {
    principalOf.current = 'analyst';
    const res = await call();
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(apiCalls()).toBeGreaterThan(0);
  });
});

describe.each(STORE_ROUTES)('$name', ({ call }) => {
  it('401 without a session, and the API is never called', async () => {
    principalOf.current = { status: 401 };
    expect((await call()).status).toBe(401);
    expect(apiCalls()).toBe(0);
  });

  it('403 on a store the principal holds nothing on (store admin of brand-a/b, URL brand-c)', async () => {
    principalOf.current = 'storeAdmin';
    const res = await call(C);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'forbidden',
      details: { relation: 'viewer', object: `store:${C}` },
    });
    expect(apiCalls()).toBe(0);
  });

  it('403 for an account that holds nothing', async () => {
    principalOf.current = 'unassigned';
    expect((await call()).status).toBe(403);
    expect(apiCalls()).toBe(0);
  });

  it('404 for a store id that is not a uuid, before the principal or the API', async () => {
    principalOf.current = 'owner';
    expect((await call('../brand-a')).status).toBe(404);
    expect(apiCalls()).toBe(0);
  });

  it('store staff on their own store reaches the API', async () => {
    principalOf.current = 'storeStaff';
    const res = await call(A);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(apiCalls()).toBeGreaterThan(0);
  });
});
