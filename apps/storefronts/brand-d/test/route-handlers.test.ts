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

/** Every file Next treats as a route handler (#793 review: not only `route.ts`). */
const ROUTE_FILE = /^route\.(ts|tsx|js|jsx|mjs)$/;

/**
 * A handler's folder (relative to `src/app`) as a request path that reaches it:
 * - a route group `(name)` adds no segment;
 * - an optional catch-all `[[...x]]` and a catch-all `[...x]` take sample segments;
 * - a dynamic `[x]` takes one sample word.
 */
export function samplePath(folder: string): string {
  const segments = folder
    .split('/')
    .filter((segment) => segment !== '' && !/^\(.+\)$/.test(segment))
    .map((segment) =>
      /^\[\[\.\.\..+\]\]$/.test(segment)
        ? 'sample-a'
        : /^\[\.\.\..+\]$/.test(segment)
          ? 'sample-a/sample-b'
          : /^\[.+\]$/.test(segment)
            ? 'sample-value'
            : segment,
    );
  return `/${segments.join('/')}`;
}

/** Every route handler outside `[locale]`, as a request path that reaches it. */
function handlersOnDisk(dir = APP): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '[locale]') found.push(...handlersOnDisk(path));
    } else if (ROUTE_FILE.test(name)) {
      found.push(samplePath(relative(APP, dir).split(sep).join('/')));
    }
  }
  return found;
}

describe('samplePath: a handler folder as a request path', () => {
  it.each([
    ['health', '/health'],
    ['r/[code]', '/r/sample-value'],
    ['(marketing)/api/hook', '/api/hook'],
    ['api/files/[...path]', '/api/files/sample-a/sample-b'],
    ['api/docs/[[...slug]]', '/api/docs/sample-a'],
  ])('%s → %s', (folder, path) => {
    expect(samplePath(folder)).toBe(path);
  });

  it('every file name Next treats as a route handler is found, not only route.ts', () => {
    for (const name of ['route.ts', 'route.tsx', 'route.js', 'route.jsx', 'route.mjs']) {
      expect(ROUTE_FILE.test(name), name).toBe(true);
    }
    for (const name of ['page.tsx', 'route.test.ts', 'router.ts']) {
      expect(ROUTE_FILE.test(name), name).toBe(false);
    }
  });
});

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
