import { describe, expect, it } from 'vitest';
import { LOCAL_DEVELOPMENT_SITE_URL, siteUrl, SiteUrlError } from '@/brand/config';
import { siteOrigin, urlOnThisSite } from '@/lib/site-origin';

/**
 * #298. "This site's origin" has one definition, it is configuration, and a production server that
 * has not been given it does not guess. Every rule here exists because its opposite shipped: the
 * silent `http://localhost:3100` default reached sitemaps and redirects, and the request's own
 * origin — the pod's, behind the ingress — reached Keycloak and the customer's address bar.
 */

const PRODUCTION = { NODE_ENV: 'production', NEXT_PHASE: 'phase-production-server' };

describe('siteUrl', () => {
  it('is SITE_URL, without a trailing slash', () => {
    expect(siteUrl({ ...PRODUCTION, SITE_URL: 'https://shop.example.com' })).toBe(
      'https://shop.example.com',
    );
    expect(siteUrl({ ...PRODUCTION, SITE_URL: 'https://shop.example.com//' })).toBe(
      'https://shop.example.com',
    );
  });

  it.each([
    ['next dev', { NODE_ENV: 'development' }],
    ['a unit test', { NODE_ENV: 'test' }],
    ['no NODE_ENV at all', {}],
  ])('falls back to the local origin in %s', (_name, env) => {
    expect(siteUrl(env)).toBe(LOCAL_DEVELOPMENT_SITE_URL);
  });

  it('falls back while next build runs: a build has no environment of its own', () => {
    expect(siteUrl({ NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' })).toBe(
      LOCAL_DEVELOPMENT_SITE_URL,
    );
  });

  it.each([
    ['unset', {}],
    ['empty', { SITE_URL: '' }],
    ['blank', { SITE_URL: '   ' }],
  ])('fails closed on a production server when SITE_URL is %s', (_name, extra) => {
    expect(() => siteUrl({ ...PRODUCTION, ...extra })).toThrow(SiteUrlError);
    expect(() => siteUrl({ ...PRODUCTION, ...extra })).toThrow(/SITE_URL is not set/);
  });

  it.each(['shop.example.com', '/shop', 'javascript:alert(1)', 'ftp://shop.example.com'])(
    'refuses a SITE_URL that is not an absolute http(s) URL: %s',
    (value) => {
      expect(() => siteUrl({ ...PRODUCTION, SITE_URL: value })).toThrow(SiteUrlError);
      // In development too: a typo should not be papered over by the fallback.
      expect(() => siteUrl({ NODE_ENV: 'development', SITE_URL: value })).toThrow(SiteUrlError);
    },
  );
});

describe('siteOrigin and urlOnThisSite', () => {
  const env = { ...PRODUCTION, SITE_URL: 'https://shop.example.com/' };

  it('is the origin of the configured URL', () => {
    expect(siteOrigin(env)).toBe('https://shop.example.com');
  });

  it('puts a path of ours on the configured origin', () => {
    expect(urlOnThisSite('/en-GB/account/orders?page=2', '/', env).toString()).toBe(
      'https://shop.example.com/en-GB/account/orders?page=2',
    );
  });

  it.each([
    ['another origin', 'https://evil.example/'],
    ['a protocol-relative URL', '//evil.example'],
    ['a backslash variant', '/\\evil.example'],
    // WHATWG URL parsing strips the tab, so this resolves to https://evil.example.
    ['a tab the URL parser strips', '/\t/evil.example'],
    ['a relative path', 'account'],
    ['nothing', null],
    ['an empty string', ''],
  ])('falls back to our own path for %s', (_name, target) => {
    const url = urlOnThisSite(target, '/en-GB/account', env);
    expect(url.toString()).toBe('https://shop.example.com/en-GB/account');
  });

  it('throws rather than resolve anything when a production server has no SITE_URL', () => {
    expect(() => siteOrigin(PRODUCTION)).toThrow(SiteUrlError);
    expect(() => urlOnThisSite('/en-GB', '/', PRODUCTION)).toThrow(SiteUrlError);
  });
});
