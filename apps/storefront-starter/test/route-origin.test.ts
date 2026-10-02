import { NextRequest, type NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Oidc from '@/lib/auth/oidc';

/**
 * #298 — one test per route handler that redirects.
 *
 * Each handler is called the way it is called **behind the ingress**: the request's own origin is
 * the pod's (`http://localhost:3100` — measured on `next start`, whatever the `Host` header says),
 * and the forwarded headers carry text the client chose. The public origin is known only from
 * `SITE_URL`. Every `Location` must be on that origin: not on the pod's, which is where these
 * handlers sent customers, and not on the header's, which would be an open redirect.
 *
 * No existing test could see the defect, because on a laptop the pod's origin and the public one
 * are the same string. Here they are three different ones.
 */

const PUBLIC = 'https://shop.public.example';
const POD = 'http://localhost:3100';
const HOSTILE = 'evil.example';
const KEYCLOAK = 'https://id.public.example';

// ── Next and the session, replaced by things a test can read ─────────────────────────────────────

const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

const getSession = vi.fn();
const clearSession = vi.fn();
const saveSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSession(),
  clearSession: () => clearSession(),
  saveSession: (session: unknown) => saveSession(session),
  sessionFromTokens: () => ({ accessToken: 'access-token', idToken: 'id-token' }),
}));

const exchangeCode = vi.fn();
vi.mock('@/lib/auth/oidc', async (importOriginal) => ({
  ...(await importOriginal<typeof Oidc>()),
  exchangeCode: (...args: unknown[]) => exchangeCode(...args),
}));

const { SiteUrlError } = await import('@/brand/config');
const signOut = await import('@/app/auth/sign-out/route');
const callback = await import('@/app/auth/callback/route');
const referral = await import('@/app/r/[code]/route');

/** A request as a route handler receives it behind the ingress. */
function behindIngress(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${POD}${path}`, {
    headers: { 'x-forwarded-host': HOSTILE, 'x-forwarded-proto': 'https', ...headers },
  });
}

function locationOf(response: Response): URL {
  const location = response.headers.get('location');
  expect(location, 'the handler redirects').not.toBeNull();
  return new URL(location!);
}

/** A production server that was never told where it lives. */
function unconfigure(): void {
  vi.stubEnv('SITE_URL', '');
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PHASE', 'phase-production-server');
}

beforeEach(() => {
  jar.clear();
  getSession.mockReset().mockResolvedValue({ idToken: 'id-token' });
  clearSession.mockReset().mockResolvedValue(undefined);
  saveSession.mockReset().mockResolvedValue(undefined);
  exchangeCode.mockReset().mockResolvedValue({});
  vi.stubEnv('SITE_URL', PUBLIC);
  vi.stubEnv('KEYCLOAK_URL', KEYCLOAK);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── POST /auth/sign-out ──────────────────────────────────────────────────────────────────────────

describe('POST /auth/sign-out', () => {
  it('asks Keycloak to return the customer to the configured origin', async () => {
    const response = await signOut.POST();

    expect(response.status).toBe(303);
    const logout = locationOf(response);
    expect(`${logout.origin}${logout.pathname}`).toBe(
      `${KEYCLOAK}/realms/customers/protocol/openid-connect/logout`,
    );
    expect(logout.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC}/`);
    expect(logout.searchParams.get('id_token_hint')).toBe('id-token');
    expect(clearSession).toHaveBeenCalledOnce();
  });

  it('takes no request, so nothing in one can choose the return address', () => {
    expect(signOut.POST).toHaveLength(0);
  });

  it('still signs the customer out when the origin is not configured, with no return address', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    unconfigure();

    const response = await signOut.POST();

    expect(response.status).toBe(303);
    const logout = locationOf(response);
    expect(logout.origin).toBe(KEYCLOAK);
    // Not the pod, not a guess: no return address at all. Keycloak shows its own signed-out page.
    expect(logout.searchParams.has('post_logout_redirect_uri')).toBe(false);
    expect(logout.searchParams.get('id_token_hint')).toBe('id-token');
    expect(clearSession).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledOnce();
  });
});

// ── GET /auth/callback ───────────────────────────────────────────────────────────────────────────

describe('GET /auth/callback', () => {
  function pendingSignIn(returnTo: string): void {
    jar.set('oidc_state', 'state-1');
    jar.set('oidc_verifier', 'verifier-1');
    jar.set('oidc_return_to', returnTo);
  }

  it('sends a refused sign-in to the account page on the configured origin', async () => {
    const response = await callback.GET(behindIngress('/auth/callback?error=access_denied'));

    expect(locationOf(response).toString()).toBe(`${PUBLIC}/en-GB/account?error=sign_in_failed`);
    expect(saveSession).not.toHaveBeenCalled();
  });

  it('sends a completed sign-in to the page that was asked for, on the configured origin', async () => {
    pendingSignIn('/en-GB/account/orders');

    const response = await callback.GET(behindIngress('/auth/callback?code=code-1&state=state-1'));

    expect(locationOf(response).toString()).toBe(`${PUBLIC}/en-GB/account/orders`);
    expect(saveSession).toHaveBeenCalledOnce();
    // The exchange names the callback on the same configured origin.
    expect(exchangeCode.mock.calls[0]![0]).toMatchObject({
      redirectUri: `${PUBLIC}/auth/callback`,
    });
  });

  it('sends a completed sign-in to the account page when the stored target is not ours', async () => {
    // A tab the URL parser strips: `/\t/evil.example` resolves to https://evil.example.
    pendingSignIn(`/\t/${HOSTILE}`);

    const response = await callback.GET(behindIngress('/auth/callback?code=code-1&state=state-1'));

    expect(locationOf(response).toString()).toBe(`${PUBLIC}/en-GB/account`);
  });

  it('never redirects to the pod or to a forwarded host', async () => {
    pendingSignIn('/en-GB/account');
    const responses = [
      await callback.GET(behindIngress('/auth/callback?error=access_denied')),
      await callback.GET(behindIngress('/auth/callback?code=code-1&state=state-1')),
    ];

    for (const response of responses) {
      const location = locationOf(response);
      expect(location.origin).toBe(PUBLIC);
      expect(location.host).not.toBe(new URL(POD).host);
      expect(location.host).not.toBe(HOSTILE);
    }
  });

  it('fails closed, before touching the session, when the origin is not configured', async () => {
    pendingSignIn('/en-GB/account');
    unconfigure();

    await expect(
      callback.GET(behindIngress('/auth/callback?code=code-1&state=state-1')),
    ).rejects.toBeInstanceOf(SiteUrlError);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(saveSession).not.toHaveBeenCalled();
    // The pending sign-in is left as it was: nothing half-done.
    expect(jar.get('oidc_verifier')).toBe('verifier-1');
  });
});

// ── GET /r/{code} ────────────────────────────────────────────────────────────────────────────────

describe('GET /r/{code}', () => {
  const CODE = 'jane-autumn';
  const context = { params: Promise.resolve({ code: CODE }) };

  function attributionOf(response: NextResponse) {
    const cookie = response.cookies.get('sf_attribution');
    expect(cookie, 'the referral is recorded').toBeDefined();
    return JSON.parse(cookie!.value) as {
      first: { ref: string | null; referrer: string | null; landing_path: string };
    };
  }

  it('lands on the shop at the configured origin', async () => {
    const response = await referral.GET(behindIngress(`/r/${CODE}`), context);

    expect(response.status).toBe(302);
    expect(locationOf(response).toString()).toBe(`${PUBLIC}/`);
  });

  it('honours a target on this site, on the configured origin', async () => {
    const response = await referral.GET(
      behindIngress(`/r/${CODE}?to=%2Fen-GB%2Fproducts`),
      context,
    );

    expect(locationOf(response).toString()).toBe(`${PUBLIC}/en-GB/products`);
  });

  it.each([
    ['another origin', 'https%3A%2F%2Fevil.example%2F'],
    ['a protocol-relative URL', '%2F%2Fevil.example'],
    ['a tab the URL parser strips', '%2F%09%2Fevil.example'],
  ])('ignores a target that is %s', async (_name, to) => {
    const response = await referral.GET(behindIngress(`/r/${CODE}?to=${to}`), context);

    expect(locationOf(response).toString()).toBe(`${PUBLIC}/`);
  });

  it("does not record the shop's own pages as an external referrer", async () => {
    // A customer clicks a referral link that is on one of our own pages. Compared against the
    // pod's origin, this Referer would look like somebody else's site.
    const response = await referral.GET(
      behindIngress(`/r/${CODE}`, { referer: `${PUBLIC}/en-GB/products` }),
      context,
    );

    const { first } = attributionOf(response);
    expect(first.ref).toBe(CODE);
    expect(first.referrer).toBeNull();
    expect(first.landing_path).toBe(`/r/${CODE}`);
  });

  it('still records a genuinely external referrer, by origin only', async () => {
    const response = await referral.GET(
      behindIngress(`/r/${CODE}`, { referer: 'https://news.example/article?reader=jane' }),
      context,
    );

    expect(attributionOf(response).first.referrer).toBe('https://news.example');
  });

  it('fails closed when the origin is not configured', async () => {
    unconfigure();

    await expect(referral.GET(behindIngress(`/r/${CODE}`), context)).rejects.toBeInstanceOf(
      SiteUrlError,
    );
  });
});
