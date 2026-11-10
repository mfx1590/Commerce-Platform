/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  CSP_HEADER,
  HSTS,
  NONCE_HEADER,
  PERMISSIONS_POLICY,
  contentSecurityPolicy,
  keycloakOrigin,
  newNonce,
  staticSecurityHeaders,
} from '@/lib/security';
import nextConfig from '../next.config.mjs';

vi.mock('@/lib/auth/oidc', () => ({
  refreshTokens: vi.fn(),
  sessionIsLive: vi.fn(),
  sessionIdOf: (idToken: string) => `sid-of-${idToken}`,
}));

const { middleware, config } = await import('@/middleware');

const NONCE = 'bm9uY2Utb2YtYS10ZXN0';

function directives(policy: string): Map<string, string> {
  return new Map(
    policy.split(';').map((part) => {
      const [name = '', ...values] = part.trim().split(/\s+/);
      return [name, values.join(' ')];
    }),
  );
}

describe('the Content-Security-Policy, in production', () => {
  const policy = contentSecurityPolicy({
    nonce: NONCE,
    keycloakUrl: 'https://id.example.test/realms/staff',
    production: true,
  });

  it('is exactly this — every directive pinned', () => {
    expect(policy).toBe(
      [
        "default-src 'self'",
        `script-src 'nonce-${NONCE}' 'strict-dynamic'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-src 'none'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self' https://id.example.test",
        'upgrade-insecure-requests',
      ].join('; '),
    );
  });

  it('runs no inline script without the nonce, and no eval', () => {
    const script = directives(policy).get('script-src') ?? '';

    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).toContain(`'nonce-${NONCE}'`);
  });

  it('lets the browser talk to this origin only — the Admin API is called server-side', () => {
    expect(directives(policy).get('connect-src')).toBe("'self'");
  });

  it('cannot be framed — clickjacking', () => {
    expect(directives(policy).get('frame-ancestors')).toBe("'none'");
  });
});

describe('the Content-Security-Policy, in development', () => {
  const policy = contentSecurityPolicy({ nonce: NONCE, keycloakUrl: undefined, production: false });

  it('adds only the eval React Refresh needs, and does not upgrade http://localhost', () => {
    expect(directives(policy).get('script-src')).toBe(
      `'nonce-${NONCE}' 'strict-dynamic' 'unsafe-eval'`,
    );
    expect(directives(policy).has('upgrade-insecure-requests')).toBe(false);
  });

  it('lets Sign out reach the local Keycloak', () => {
    expect(directives(policy).get('form-action')).toBe("'self' http://localhost:8180");
  });
});

describe('keycloakOrigin', () => {
  it('keeps the origin only', () => {
    expect(keycloakOrigin('https://id.example.test:8443/realms/staff/')).toBe(
      'https://id.example.test:8443',
    );
  });

  it('in development, falls back to the local default rather than a directive the browser would drop', () => {
    expect(keycloakOrigin('not a url')).toBe('http://localhost:8180');
    expect(keycloakOrigin(undefined)).toBe('http://localhost:8180');
  });

  it('in production, refuses to guess: unset, empty or malformed throws', () => {
    for (const value of [undefined, '', 'not a url']) {
      expect(() => keycloakOrigin(value, true)).toThrow(/KEYCLOAK_URL must be set/);
    }
    expect(() =>
      contentSecurityPolicy({ nonce: NONCE, keycloakUrl: undefined, production: true }),
    ).toThrow(/KEYCLOAK_URL must be set/);
  });
});

describe('newNonce', () => {
  it('is 128 bits of base64, new every time', () => {
    const a = newNonce();

    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newNonce()).not.toBe(a);
  });
});

describe('the static headers (next.config.mjs)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('are exactly these in production, on every path', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(await nextConfig.headers?.()).toEqual([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        ],
      },
    ]);
  });

  it('leave HSTS out of a development server', () => {
    expect(staticSecurityHeaders({ production: false }).map((h) => h.key)).toEqual([
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Permissions-Policy',
    ]);
    expect(HSTS).toBe('max-age=63072000; includeSubDomains');
    expect(PERMISSIONS_POLICY).toBe('camera=(), microphone=(), geolocation=()');
  });

  it('do not announce the framework (no X-Powered-By)', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});

describe('the middleware sets the CSP', () => {
  it('on the sign-in error page, which needs no session, with the nonce forwarded to Next', async () => {
    const response = await middleware(
      new NextRequest(new URL('http://localhost:3000/auth/error?reason=x')),
    );
    const policy = response.headers.get(CSP_HEADER) ?? '';
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];

    expect(response.headers.get('location')).toBeNull();
    expect(nonce).toBeDefined();
    // NextResponse.next({ request: { headers } }) marks the forwarded request headers like this.
    expect(response.headers.get(`x-middleware-request-${NONCE_HEADER}`)).toBe(nonce);
    expect(response.headers.get(`x-middleware-request-${CSP_HEADER.toLowerCase()}`)).toBe(policy);
  });

  it('on the redirect to sign in, and with a new nonce per response', async () => {
    const first = await middleware(new NextRequest(new URL('http://localhost:3000/stores')));
    const second = await middleware(new NextRequest(new URL('http://localhost:3000/stores')));

    expect(first.headers.get('location')).toContain('/api/auth/login');
    expect(first.headers.get(CSP_HEADER)).toContain("frame-ancestors 'none'");
    expect(first.headers.get(CSP_HEADER)).not.toBe(second.headers.get(CSP_HEADER));
  });

  it('matches the error page, while the probe and the auth endpoints stay outside', () => {
    const pattern = new RegExp(`^${config.matcher[0] as string}$`);

    expect(pattern.test('/auth/error')).toBe(true);
    expect(pattern.test('/health')).toBe(false);
    expect(pattern.test('/api/auth/logout')).toBe(false);
  });
});
