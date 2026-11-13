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

/**
 * `getMiddlewareMatchers` is Next's own compiler, but it lives at a PRIVATE path (`next/dist/…`)
 * that a Next upgrade can move or reshape (#793 review). It is loaded defensively: the guard test
 * below fails with an instruction if it moved, and the matcher cases are skipped rather than
 * crashing the file, so the one red test says exactly what to do.
 */
const NEXT_PRIVATE = 'next/dist/build/analysis/get-page-static-info';
type Compile = (
  matcher: string | string[],
  nextConfig: Record<string, unknown>,
) => { regexp: string; originalSource: string }[];

let compile: Compile | undefined;
let loadError: unknown;
try {
  const loaded = createRequire(import.meta.url)(NEXT_PRIVATE) as {
    getMiddlewareMatchers?: unknown;
  };
  if (typeof loaded.getMiddlewareMatchers !== 'function') {
    throw new Error('the module no longer exports getMiddlewareMatchers');
  }
  compile = loaded.getMiddlewareMatchers as Compile;
} catch (error) {
  loadError = error;
}

const compiled = compile?.(config.matcher, {})[0];

describe('the Next internals this test relies on (guard)', () => {
  it(`Next still compiles middleware matchers at ${NEXT_PRIVATE}`, () => {
    expect(
      loadError,
      `Next moved or reshaped its middleware-matcher compiler (${String(loadError)}). Find the new home of getMiddlewareMatchers in node_modules/next/dist, update NEXT_PRIVATE, and re-check that the matcher cases below still mean what they say.`,
    ).toBeUndefined();
    expect(compiled?.regexp, 'the compiled matcher has a regexp string').toEqual(
      expect.any(String),
    );
  });
});

const matcher = new RegExp(compiled?.regexp ?? '$^');

describe.skipIf(compiled === undefined)('middleware matcher, as Next compiles it', () => {
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
