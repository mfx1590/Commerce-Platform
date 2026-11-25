/**
 * `fetchExportBundle` (#965 review: it had no test, and it is the module that actually touches the
 * Admin API with a credential attached).
 *
 * What is pinned here is everything about the request that must not drift:
 *
 * - the URL is built from the three ids, each encoded;
 * - the session token goes in an **Authorization header**, never in the URL;
 * - the response is read as **text** and handed back untouched — never parsed;
 * - `cache: 'no-store'` and `redirect: 'error'`, so one person's whole record is neither cached nor
 *   followed to a redirect target with the credential attached;
 * - a thrown fetch becomes a 503 with our own body, not an exception out of the module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const session = vi.hoisted(() => ({ current: { accessToken: 'token-abc' } as unknown }));
vi.mock('@/lib/auth/current-session', () => ({
  getSession: async () => session.current,
}));
vi.mock('@/lib/env', () => ({ env: { adminApiUrl: 'https://api.test' } }));

const { fetchExportBundle } = await import('@/lib/customers/bundle');

const STORE = '00000000-0000-4000-8000-000000000031';
const CUSTOMER = '50000000-0000-4000-8000-000000000001';
const EXPORT = '53000000-0000-4000-8000-000000000001';
const BODY = '{"profile":{},"orders":[]}';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  session.current = { accessToken: 'token-abc' };
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(
    new Response(BODY, { status: 200, headers: { 'content-type': 'application/json' } }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the request it makes', () => {
  it('builds the URL from the three ids and carries the token in a header, not the URL', async () => {
    await fetchExportBundle(STORE, CUSTOMER, EXPORT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://api.test/admin/stores/${STORE}/customers/${CUSTOMER}/exports/${EXPORT}`,
    );
    // The credential is a header. Nothing authenticating may reach a URL, which is the whole point.
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer token-abc');
    expect(url).not.toContain('token');
  });

  it('does not cache, and refuses to follow a redirect with the credential attached', async () => {
    await fetchExportBundle(STORE, CUSTOMER, EXPORT);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.cache).toBe('no-store');
    expect(init.redirect).toBe('error');
  });

  it('sends no Authorization header at all when there is no session', async () => {
    session.current = null;
    await fetchExportBundle(STORE, CUSTOMER, EXPORT);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('encodes each id rather than interpolating it raw', async () => {
    await fetchExportBundle('a/b', 'c?d', 'e#f');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api.test/admin/stores/a%2Fb/customers/c%3Fd/exports/e%23f');
  });
});

describe('what it gives back', () => {
  it('hands the body back as text, untouched and unparsed', async () => {
    const result = await fetchExportBundle(STORE, CUSTOMER, EXPORT);
    expect(result).toEqual({
      ok: true,
      status: 200,
      body: BODY,
      contentType: 'application/json',
    });
  });

  it('reports a failure with its status and body, without interpreting either', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"code":"gone"}', {
        status: 410,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await fetchExportBundle(STORE, CUSTOMER, EXPORT);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(410);
    expect(result.body).toBe('{"code":"gone"}');
  });

  it('falls back to a sane content type when the API sends none', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const result = await fetchExportBundle(STORE, CUSTOMER, EXPORT);
    // `Response` adds its own default for a string body; the point is that it is never empty.
    expect(result.contentType).not.toBe('');
  });

  it('a thrown fetch becomes a 503 with our own body, not an exception', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'));
    const result = await fetchExportBundle(STORE, CUSTOMER, EXPORT);
    expect(result).toEqual({
      ok: false,
      status: 503,
      body: JSON.stringify({ code: 'unavailable', message: 'The Admin API did not answer' }),
      contentType: 'application/json',
    });
  });

  it('a refused redirect is a throw, so it lands in the same 503', async () => {
    // `redirect: 'error'` makes the platform reject; the module must not leak that out.
    fetchMock.mockRejectedValue(new TypeError('unexpected redirect'));
    expect((await fetchExportBundle(STORE, CUSTOMER, EXPORT)).status).toBe(503);
  });
});
