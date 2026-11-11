import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

/**
 * Which requests reach the middleware, compiled exactly as Next compiles it (#790): Next's own
 * `getMiddlewareMatchers` wraps the source with its data-route prefix and transport suffixes, and
 * the server tests a pathname against the resulting `regexp`. Since #790 everything but Next's
 * build output is matched, so every response can carry the CSP; the route handlers are sorted out
 * inside the middleware (test/route-handlers.test.ts).
 */

// The middleware module builds next-intl's middleware at import; only `config` matters here.
vi.mock('next-intl/middleware', () => ({ default: () => () => undefined }));
const { config } = await import('@/middleware');

const require = createRequire(import.meta.url);
const { getMiddlewareMatchers } = require('next/dist/build/analysis/get-page-static-info') as {
  getMiddlewareMatchers: (
    matcher: string | string[],
    nextConfig: Record<string, unknown>,
  ) => { regexp: string; originalSource: string }[];
};

const [compiled] = getMiddlewareMatchers(config.matcher, {});
const matcher = new RegExp(compiled!.regexp);

describe('middleware matcher, as Next compiles it', () => {
  it('compiles our source', () => {
    expect(compiled!.originalSource).toBe(config.matcher[0]);
  });

  it.each([
    '/',
    '/en-GB',
    '/en-GB/products',
    '/en-GB/checkout/payment',
    '/authors',
    '/apiary',
    '/healthy',
    '/api',
    '/api/nope',
    '/api/cms/revalidate',
    '/auth',
    '/auth/callback',
    '/r/friend-code',
    '/r/a/b',
    '/health',
    '/robots.txt',
    '/no-such-file.png',
  ])('runs on %s (so the response carries the policy)', (path) => {
    expect(matcher.test(path)).toBe(true);
  });

  it.each(['/_next/static/chunks/main.js', '/_next/image', '/_vercel/insights', '/_vercel'])(
    'skips Next’s build output %s',
    (path) => {
      expect(matcher.test(path)).toBe(false);
    },
  );
});
