import { afterEach, describe, expect, it, vi } from 'vitest';
import robots, { dynamic } from '@/app/robots';

/**
 * Indexing is an explicit opt-in. Getting this wrong fails silently in the costly direction: a
 * staging site in a search index outranks the real one for its own brand name.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('robots.txt', () => {
  it('is rendered per request, so a deployment’s environment decides — not the build machine’s', () => {
    // As a static route it was baked by `next build`, which always runs with NODE_ENV=production,
    // so every image — staging included — said Allow: /.
    expect(dynamic).toBe('force-dynamic');
  });

  it('refuses everything unless indexing is explicitly allowed', () => {
    vi.stubEnv('ROBOTS_ALLOW_INDEXING', '');
    vi.stubEnv('NODE_ENV', 'production');
    // NODE_ENV=production is not permission: a staging image runs in production mode too.
    expect(robots().rules).toEqual([{ userAgent: '*', disallow: '/' }]);
  });

  it('allows the catalogue, and keeps the funnel and account area out, once opted in', () => {
    vi.stubEnv('ROBOTS_ALLOW_INDEXING', '1');
    vi.stubEnv('SITE_URL', 'https://brand-a.example');
    const result = robots();

    expect(result.rules).toEqual([
      expect.objectContaining({
        allow: '/',
        disallow: expect.arrayContaining(['/*/cart', '/*/checkout/', '/*/account', '/*/orders/']),
      }),
    ]);
    expect(result.sitemap).toBe('https://brand-a.example/sitemap.xml');
  });

  it('treats any value other than "1" as not opted in', () => {
    for (const value of ['true', 'yes', '0', ' 1']) {
      vi.stubEnv('ROBOTS_ALLOW_INDEXING', value);
      expect(robots().rules).toEqual([{ userAgent: '*', disallow: '/' }]);
    }
  });
});
