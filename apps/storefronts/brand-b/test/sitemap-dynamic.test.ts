import { describe, expect, it } from 'vitest';
import * as sitemapPages from '@/app/sitemap';
import * as sitemapIndex from '@/app/sitemap.xml/route';

/**
 * #302. Both sitemap routes build absolute URLs from `SITE_URL`, so neither may be prerendered: a
 * route rendered by `next build` keeps the build machine's origin, and with `revalidate` it went on
 * serving it for an hour after every deploy. The served bytes are asserted in
 * `e2e/runtime-origin.spec.ts`, against a server built with one origin and started with another;
 * this is the cheap half, the same pin `robots.txt` has.
 */
describe('sitemap routes are rendered per request', () => {
  it.each([
    ['/sitemap/<n>.xml', sitemapPages as Record<string, unknown>],
    ['/sitemap.xml (the index)', sitemapIndex as Record<string, unknown>],
  ])('%s is force-dynamic and sets no revalidate', (_route, module) => {
    expect(module['dynamic']).toBe('force-dynamic');
    // `revalidate` on a route is what lets Next prerender it and serve the copy.
    expect(module['revalidate']).toBeUndefined();
  });
});
