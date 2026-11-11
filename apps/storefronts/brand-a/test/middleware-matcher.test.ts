import { describe, expect, it, vi } from 'vitest';

/**
 * #783 review: the middleware's matcher excluded `api|auth|health` without anchoring, so
 * `/authors`, `/apiary` and `/healthy` skipped the middleware and rendered a 404 page with no CSP.
 * The exclusions are now whole path segments. Next anchors a matcher source as `^<source>$`
 * against the pathname, which is what this compiles.
 */

// The middleware module builds next-intl's middleware at import; only `config` matters here.
vi.mock('next-intl/middleware', () => ({ default: () => () => undefined }));
const { config } = await import('@/middleware');

const [source] = config.matcher;
const matcher = new RegExp(`^${source}$`);

describe('middleware matcher', () => {
  it.each([
    '/',
    '/en-GB',
    '/en-GB/products',
    '/authors',
    '/apiary',
    '/healthy',
    '/auth-help',
    '/rss',
    '/robots.txt',
    '/no-such-file.png',
  ])('runs on %s (and so sets the policy)', (path) => {
    expect(matcher.test(path)).toBe(true);
  });

  it.each([
    '/api/cms/preview',
    '/api',
    '/auth/callback',
    '/auth',
    '/health',
    '/health/',
    '/r/friend-code',
    '/_next/static/chunks/main.js',
    '/_vercel/insights',
  ])('skips the route handler or build output %s', (path) => {
    expect(matcher.test(path)).toBe(false);
  });
});
