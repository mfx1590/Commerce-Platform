import { describe, expect, it } from 'vitest';
import {
  contentSecurityPolicy,
  isCheckoutZone,
  keycloakOrigin,
  newNonce,
  parseFrameHosts,
  WILDCARD_EMBED_DOMAINS,
  type CspInput,
} from '@/lib/csp';

/**
 * The storefront CSP. Every failure mode here is silent (a blocked sign-out, a blocked embed, a
 * blocked bootstrap script, an injected directive, or a policy the browser drops entirely), so the
 * FULL policy string is pinned per zone. A test that parses the policy into a map would hide a
 * duplicated or injected directive (#783 review).
 */

const NONCE = 'bm9uY2Utd29yZA==';
const BASE: CspInput = {
  nonce: NONCE,
  keycloakUrl: 'https://auth.example.com/realms/customers',
  frameHosts: ['https://builder.io', 'https://*.framer.app'],
  pathname: '/en-GB/products',
  production: true,
};
const csp = (overrides: Partial<CspInput> = {}) => contentSecurityPolicy({ ...BASE, ...overrides });

const STRIPE_SCRIPTS = 'https://js.stripe.com https://*.js.stripe.com';
const STRIPE_FRAMES = 'https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com';
const fullPolicy = (frames: string, extraScript = '') =>
  [
    "default-src 'self'",
    `script-src 'nonce-${NONCE}' 'strict-dynamic' ${STRIPE_SCRIPTS}${extraScript}`,
    "img-src 'self' data: blob: https://res.cloudinary.com https://images.unsplash.com https://picsum.photos",
    "font-src 'self' data:",
    "media-src 'self' https://res.cloudinary.com",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' https://api.stripe.com",
    `frame-src 'self' ${frames}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self' https://auth.example.com",
    'upgrade-insecure-requests',
  ].join('; ');

describe('the full production policy, per zone (#782, #783)', () => {
  it('outside checkout: nonce + strict-dynamic, Stripe and the vetted embed hosts as frames', () => {
    expect(csp()).toBe(fullPolicy(`${STRIPE_FRAMES} https://builder.io https://*.framer.app`));
  });

  it('the checkout zone: the same script policy, Stripe-only frames', () => {
    expect(csp({ pathname: '/en-GB/checkout/payment' })).toBe(fullPolicy(STRIPE_FRAMES));
  });

  it('development adds only unsafe-eval (React Refresh), and never unsafe-inline', () => {
    expect(csp({ production: false })).toBe(
      fullPolicy(`${STRIPE_FRAMES} https://builder.io https://*.framer.app`, " 'unsafe-eval'"),
    );
  });

  it('each directive appears exactly once, in every zone', () => {
    for (const pathname of ['/en-GB', '/en-GB/checkout', '/en-GB/orders/x']) {
      const names = csp({ pathname })
        .split(';')
        .map((part) => part.trim().split(/\s+/)[0]);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('a nonce is 128 random bits, new every time', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => newNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(atob(nonce)).toHaveLength(16);
  });
});

describe('form-action', () => {
  it('follows the deployment’s own identity provider, so sign-out can end the SSO session', () => {
    expect(keycloakOrigin('https://auth.staging.example.com/realms/customers', true)).toBe(
      'https://auth.staging.example.com',
    );
    expect(keycloakOrigin('https://auth.example.com:8443/realms/x')).toBe(
      'https://auth.example.com:8443',
    );
  });

  it('production: a missing or malformed KEYCLOAK_URL throws (no silent localhost)', () => {
    expect(() => keycloakOrigin(undefined, true)).toThrow(/KEYCLOAK_URL must be set/);
    expect(() => keycloakOrigin('', true)).toThrow(/KEYCLOAK_URL must be set/);
    expect(() => keycloakOrigin('not a url', true)).toThrow(/KEYCLOAK_URL must be set/);
    expect(() => csp({ keycloakUrl: undefined })).toThrow(/KEYCLOAK_URL must be set/);
  });

  it('development falls back to the local Keycloak', () => {
    expect(keycloakOrigin(undefined)).toBe('http://localhost:8180');
    expect(keycloakOrigin('not a url')).toBe('http://localhost:8180');
  });
});

describe('CSP_FRAME_HOSTS: the frame-source grammar (#782, #783)', () => {
  const ORIGIN = 'not an https origin (lower-case host, optional port, nothing else)';
  const WILDCARD = 'wildcard (not https://*.<allowed site-builder domain>)';

  it('accepts lower-case https origins (trailing slash dropped, port kept) without duplicates', () => {
    expect(
      parseFrameHosts(
        'https://builder.io https://embed.example.com:8443/ https://builder.io https://xn--bcher-kva.example',
      ),
    ).toEqual({
      hosts: [
        'https://builder.io',
        'https://embed.example.com:8443',
        'https://xn--bcher-kva.example',
      ],
      refused: [],
    });
    expect(parseFrameHosts(undefined)).toEqual({ hosts: [], refused: [] });
  });

  it('accepts a wildcard only for the named site-builder domains', () => {
    expect(WILDCARD_EMBED_DOMAINS).toEqual(['framer.app', 'framer.website', 'builder.io']);
    expect(
      parseFrameHosts('https://*.framer.app https://*.framer.website https://*.builder.io'),
    ).toEqual({
      hosts: ['https://*.framer.app', 'https://*.framer.website', 'https://*.builder.io'],
      refused: [],
    });
  });

  it.each([
    // Directive injection: WHATWG URL accepts these in a host; the grammar does not.
    ['a semicolon (directive injection)', 'https://a.example;script-src-elem', ORIGIN],
    ['a semicolon before a directive name', 'https://a.example;form-action', ORIGIN],
    ['a comma', 'https://a.example,https://b.example', ORIGIN],
    ['a quote', "https://a.example'unsafe-inline'", ORIGIN],
    ['upper case', 'https://Embed.Example.com', ORIGIN],
    ['an IDN (use its xn-- form)', 'https://bücher.example', ORIGIN],
    ['an IPv4 literal', 'https://192.0.2.1', ORIGIN],
    ['an IPv6 literal', 'https://[2001:db8::1]', ORIGIN],
    ['a single-label host', 'https://localhost', ORIGIN],
    ['a path', 'https://www.youtube.com/embed', ORIGIN],
    ['a query', 'https://player.example.com?x=1', ORIGIN],
    ['plain http', 'http://insecure.example.com', ORIGIN],
    ['another scheme', 'data:text/html,hi', ORIGIN],
    ['credentials', 'https://user:word@example.com', ORIGIN],
    ['no scheme', 'example.com', ORIGIN],
    ['a wildcard on any other domain', 'https://*.example.com', WILDCARD],
    ['a wildcard one level too deep', 'https://*.sites.framer.app', WILDCARD],
    ['a look-alike domain', 'https://*.framer.app.evil.example', WILDCARD],
    ['a bare wildcard', '*', WILDCARD],
    ['a wildcard over http', 'http://*.framer.app', WILDCARD],
    ['a wildcard with a path', 'https://*.framer.app/embed', WILDCARD],
  ])('refuses %s, and says why', (_, entry, reason) => {
    expect(parseFrameHosts(`https://builder.io ${entry}`)).toEqual({
      hosts: ['https://builder.io'],
      refused: [{ entry, reason }],
    });
  });

  it('an injection attempt never reaches the policy string', () => {
    const { hosts } = parseFrameHosts(
      'https://a.example;script-src-elem https://evil.example https://a.example;form-action',
    );
    const policy = csp({ frameHosts: hosts });
    expect(policy).not.toContain('script-src-elem');
    expect(policy.match(/form-action/g)).toHaveLength(1);
  });
});

describe('the zones (#783 decision)', () => {
  it.each([
    '/en-GB/checkout',
    '/en-GB/checkout/address',
    '/en-GB/checkout/payment',
    '/de-DE/checkout/review',
    '/en-GB/orders/7f8d0f60-6a4f-4a3c-9a54-3b1e2c4d5e6f',
  ])('%s is the checkout zone: Stripe-only frames', (pathname) => {
    expect(isCheckoutZone(pathname)).toBe(true);
    expect(csp({ pathname })).toContain(`frame-src 'self' ${STRIPE_FRAMES};`);
  });

  it.each([
    '/en-GB',
    '/en-GB/products',
    '/en-GB/products/classic-tee',
    '/en-GB/cart',
    '/en-GB/account',
    '/en-GB/account/orders',
    '/en-GB/campaign/spring',
    '/en-GB/pages/checkout-help',
    '/en-GB/checkouts',
    '/en-GB/no-such-page',
    '/checkout',
    '/no-such-file.png',
  ])('%s is outside it: Stripe plus the embed hosts', (pathname) => {
    expect(isCheckoutZone(pathname)).toBe(false);
    expect(csp({ pathname })).toContain(
      `frame-src 'self' ${STRIPE_FRAMES} https://builder.io https://*.framer.app;`,
    );
  });
});
