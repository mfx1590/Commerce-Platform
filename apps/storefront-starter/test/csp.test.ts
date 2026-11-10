import { describe, expect, it } from 'vitest';
import {
  contentSecurityPolicy,
  isEmbedRoute,
  keycloakOrigin,
  newNonce,
  parseFrameHosts,
  WILDCARD_EMBED_DOMAINS,
  type CspInput,
} from '@/lib/csp';

/**
 * The storefront CSP. Every failure mode here is silent (a blocked sign-out, a blocked embed, a
 * blocked bootstrap script, or a policy the browser drops entirely), so each directive that has
 * caused or could cause one is pinned. #782 made the script policy nonce-based.
 */

function directives(policy: string): Map<string, string> {
  return new Map(
    policy.split(';').map((part) => {
      const [name = '', ...values] = part.trim().split(/\s+/);
      return [name, values.join(' ')];
    }),
  );
}

const BASE: CspInput = {
  nonce: 'bm9uY2Utd29yZA==',
  keycloakUrl: undefined,
  frameHosts: ['https://builder.io', 'https://embed.example.com'],
  pathname: '/en-GB/products',
  production: true,
};
const policy = (overrides: Partial<CspInput> = {}) =>
  directives(contentSecurityPolicy({ ...BASE, ...overrides }));

describe('script-src (#782)', () => {
  it('production: this response’s nonce and strict-dynamic, no unsafe-inline, no unsafe-eval', () => {
    const scripts = policy().get('script-src') ?? '';
    expect(scripts.split(' ')).toEqual([
      "'nonce-bm9uY2Utd29yZA=='",
      "'strict-dynamic'",
      'https://js.stripe.com',
    ]);
    expect(scripts).not.toContain('unsafe-inline');
    expect(scripts).not.toContain('unsafe-eval');
  });

  it('development adds only what next dev needs (eval for React Refresh)', () => {
    const scripts = policy({ production: false }).get('script-src') ?? '';
    expect(scripts).toContain("'unsafe-eval'");
    expect(scripts).not.toContain('unsafe-inline');
  });

  it('a nonce is 128 random bits, new every time', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => newNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(atob(nonce)).toHaveLength(16);
  });
});

describe('form-action', () => {
  it('allows the deployment’s own identity provider, so sign-out can end the SSO session', () => {
    // Chrome checks form-action against the URL after redirects; sign-out answers 303 to Keycloak.
    expect(
      policy({ keycloakUrl: 'https://auth.staging.example.com/realms/customers' }).get(
        'form-action',
      ),
    ).toBe("'self' https://auth.staging.example.com");
  });

  it('follows the value it is given: the whole point of building it per request', () => {
    expect(policy({ keycloakUrl: 'https://auth.dev.example.com' }).get('form-action')).toContain(
      'auth.dev.example.com',
    );
    expect(
      policy({ keycloakUrl: 'https://auth.staging.example.com' }).get('form-action'),
    ).toContain('auth.staging.example.com');
  });

  it('falls back to the local default rather than emitting a directive the browser would reject', () => {
    expect(keycloakOrigin(undefined)).toBe('http://localhost:8180');
    expect(keycloakOrigin('not a url')).toBe('http://localhost:8180');
    expect(keycloakOrigin('https://auth.example.com:8443/realms/x')).toBe(
      'https://auth.example.com:8443',
    );
  });
});

describe('CSP_FRAME_HOSTS: bare https origins, and the named site-builder wildcards (#782)', () => {
  it('accepts bare origins (a trailing slash is the same origin) and drops duplicates', () => {
    expect(
      parseFrameHosts('https://builder.io https://embed.example.com:8443/ https://builder.io'),
    ).toEqual({ hosts: ['https://builder.io', 'https://embed.example.com:8443'], refused: [] });
    expect(parseFrameHosts(undefined)).toEqual({ hosts: [], refused: [] });
  });

  it('accepts a wildcard only for the named site-builder domains, exactly as written', () => {
    expect(WILDCARD_EMBED_DOMAINS).toEqual(['framer.app', 'framer.website', 'builder.io']);
    expect(
      parseFrameHosts('https://*.framer.app https://*.framer.website https://*.builder.io'),
    ).toEqual({
      hosts: ['https://*.framer.app', 'https://*.framer.website', 'https://*.builder.io'],
      refused: [],
    });
  });

  const WILDCARD = 'wildcard (not an allowed site-builder domain)';
  it.each([
    ['a wildcard on any other domain', 'https://*.example.com', WILDCARD],
    ['a wildcard one level too deep', 'https://*.sites.framer.app', WILDCARD],
    ['a look-alike domain', 'https://*.framer.app.evil.example', WILDCARD],
    ['a bare wildcard', '*', WILDCARD],
    ['a wildcard over http', 'http://*.framer.app', WILDCARD],
    ['a wildcard with a path', 'https://*.framer.app/embed', WILDCARD],
    ['a path', 'https://www.youtube.com/embed', 'not a bare origin (path, query or fragment)'],
    ['a query', 'https://player.example.com?x=1', 'not a bare origin (path, query or fragment)'],
    ['plain http', 'http://insecure.example.com', 'not https'],
    ['another scheme', 'data:text/html,hi', 'not https'],
    ['credentials', 'https://user:word@example.com', 'credentials'],
    ['not a URL', 'example.com', 'not a URL'],
  ])('refuses %s, and says why', (_, entry, reason) => {
    expect(parseFrameHosts(`https://builder.io ${entry}`)).toEqual({
      hosts: ['https://builder.io'],
      refused: [{ entry, reason }],
    });
  });
});

describe('frame-src: embed hosts on embed routes only (#782)', () => {
  const STRIPE_ONLY = "'self' https://js.stripe.com https://hooks.stripe.com";

  it.each([
    '/en-GB',
    '/en-GB/',
    '/en-GB/campaign/spring',
    '/de-DE/pages/about',
    '/en-GB/legal/terms',
  ])('%s is an embed route: Stripe plus the vetted embed hosts', (pathname) => {
    expect(isEmbedRoute(pathname)).toBe(true);
    expect(policy({ pathname }).get('frame-src')).toBe(
      `${STRIPE_ONLY} https://builder.io https://embed.example.com`,
    );
  });

  it.each([
    '/en-GB/products',
    '/en-GB/products/classic-tee',
    '/en-GB/categories/t-shirts',
    '/en-GB/cart',
    '/en-GB/checkout',
    '/en-GB/checkout/payment',
    '/de-DE/checkout/review',
    '/en-GB/orders/7f8d0f60-6a4f-4a3c-9a54-3b1e2c4d5e6f',
    '/en-GB/account',
    '/en-GB/account/orders',
    '/en-GB/no-such-page',
    '/en-GB/campaigns-are-not-campaign',
    '/no-such-file.png',
  ])('%s frames only ourselves and Stripe', (pathname) => {
    expect(isEmbedRoute(pathname)).toBe(false);
    expect(policy({ pathname }).get('frame-src')).toBe(STRIPE_ONLY);
  });
});

describe('the fixed directives', () => {
  const fixed = policy();

  it('default-src self; nothing may frame us (clickjacking a checkout)', () => {
    expect(fixed.get('default-src')).toBe("'self'");
    expect(fixed.get('frame-ancestors')).toBe("'none'");
  });

  it('forbids plugins and any <base> (#782: none, not self)', () => {
    expect(fixed.get('object-src')).toBe("'none'");
    expect(fixed.get('base-uri')).toBe("'none'");
  });

  it('plays media from this origin and Cloudinary only: the hero loops (#330)', () => {
    expect(fixed.get('media-src')).toBe("'self' https://res.cloudinary.com");
  });

  it('lets the browser talk to this origin and to Stripe’s API only (#358)', () => {
    expect(fixed.get('connect-src')).toBe("'self' https://api.stripe.com");
  });

  it('styles may be inline (React style attributes); that is not script execution', () => {
    expect(fixed.get('style-src')).toBe("'self' 'unsafe-inline'");
  });
});
