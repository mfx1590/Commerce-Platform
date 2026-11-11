import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyPath, ROUTE_HANDLERS } from '@/lib/route-handlers';

/**
 * #790: the middleware passes real route handlers through and answers any other path under a
 * handler prefix with a plain-text 404. The handler list is hand-written, so this keeps it equal to
 * the `route.ts` files on disk: a new handler that is not listed would get that 404.
 */

const APP = fileURLToPath(new URL('../src/app', import.meta.url));

/** Every `route.ts` outside `[locale]`, as a request path (a `[param]` segment becomes a word). */
function handlersOnDisk(dir = APP): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '[locale]') found.push(...handlersOnDisk(path));
    } else if (name === 'route.ts') {
      const route = relative(APP, dir).split(sep).join('/');
      found.push(`/${route.replace(/\[[^\]]+\]/g, 'sample-value')}`);
    }
  }
  return found;
}

describe('route handlers outside the locale tree', () => {
  // sitemap.xml is a route handler too, but a file path: the middleware's file branch serves it.
  const onDisk = handlersOnDisk().filter((path) => !/\.[a-z]+$/.test(path));

  it('every handler on disk is passed through (none would get the 404)', () => {
    expect(onDisk.length).toBeGreaterThan(5);
    for (const path of onDisk) expect(classifyPath(path), path).toBe('handler');
  });

  it('every listed handler exists on disk (no stale entry)', () => {
    for (const handler of ROUTE_HANDLERS) {
      expect(
        onDisk.some((path) => handler.test(path)),
        `${handler} has a route.ts`,
      ).toBe(true);
    }
  });

  it.each([
    '/api',
    '/api/',
    '/api/nope',
    '/api/cms',
    '/auth',
    '/auth/x',
    '/r',
    '/r/a/b',
    '/health/x',
  ])('%s has no handler: the middleware answers a plain-text 404', (path) =>
    expect(classifyPath(path)).toBe('no-handler'),
  );

  it.each([
    '/',
    '/en-GB',
    '/en-GB/products',
    '/authors',
    '/apiary',
    '/healthy',
    '/rss',
    '/rewards',
  ])('%s is a page: the locale tree', (path) => expect(classifyPath(path)).toBe('page'));

  it('a trailing slash is the same path', () => {
    expect(classifyPath('/health/')).toBe('handler');
    expect(classifyPath('/auth/callback/')).toBe('handler');
  });
});
