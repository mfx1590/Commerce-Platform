import { describe, expect, it } from 'vitest';
import type { CmsConfig } from '@/lib/cms/config';
import { handlePreview, handlePreviewExit } from '@/lib/cms/handlers';

/**
 * #319: behind the ingress a route handler's own URL is the pod's address (`localhost:3100`,
 * whatever `Host` or `X-Forwarded-Host` says), so a redirect built on it leaves the site. Both
 * preview redirects must land on the configured origin — `SITE_URL`, read at request time — and
 * never on anything the request carries.
 */

const CONFIG: CmsConfig = {
  projectId: 'project',
  apiVersion: '2025-02-19',
  readToken: 'token',
  previewSecret: 'preview-secret',
  webhookSecret: 'webhook',
};
const PUBLIC = 'https://shop.public.example';
const PRODUCTION = { NODE_ENV: 'production', SITE_URL: PUBLIC };
const deps = { config: CONFIG, dataset: 'brand-a', secure: true, env: PRODUCTION };

/** The same request, as the server sees it in three deployments. */
function asSeenByTheServer(path: string): [string, Request][] {
  return [
    ['on the pod’s own origin', new Request(`http://localhost:3100${path}`)],
    [
      'on the pod’s origin with a hostile forwarded host',
      new Request(`http://localhost:3100${path}`, {
        headers: {
          host: 'evil.example',
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'https',
        },
      }),
    ],
    ['on the public origin', new Request(`${PUBLIC}${path}`)],
  ];
}

const ENTRY = '/api/cms/preview?secret=preview-secret&redirect=/en-GB/pages/about';
const EXIT = '/api/cms/preview/exit?redirect=/en-GB/pages/about';

describe('preview redirects behind the ingress (#319)', () => {
  it.each(asSeenByTheServer(ENTRY))(
    'entering preview %s redirects to the configured site and sets the cookie',
    (_label, request) => {
      const response = handlePreview(request, deps);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(`${PUBLIC}/en-GB/pages/about`);
      expect(response.headers.get('set-cookie')).toMatch(/^cms_preview=[^;]+;.*HttpOnly/);
    },
  );

  it.each(asSeenByTheServer(EXIT))(
    'leaving preview %s redirects to the configured site and clears the cookie',
    (_label, request) => {
      const response = handlePreviewExit(request, { secure: true, env: PRODUCTION });

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(`${PUBLIC}/en-GB/pages/about`);
      expect(response.headers.get('set-cookie')).toMatch(/^cms_preview=;.*Max-Age=0/);
    },
  );

  it('an off-site target still collapses to the home page — of the configured site', () => {
    for (const target of ['https://evil.example', '//evil.example', '%2F%09%2Fevil.example']) {
      const exit = handlePreviewExit(
        new Request(`http://localhost:3100/api/cms/preview/exit?redirect=${target}`),
        { secure: true, env: PRODUCTION },
      );
      const entry = handlePreview(
        new Request(
          `http://localhost:3100/api/cms/preview?secret=preview-secret&redirect=${target}`,
        ),
        deps,
      );
      expect(exit.headers.get('location'), target).toBe(`${PUBLIC}/`);
      expect(entry.headers.get('location'), target).toBe(`${PUBLIC}/`);
      expect(entry.headers.get('set-cookie')).toMatch(/^cms_preview=[^;]+;/);
    }
  });

  it('fails closed: a production server without SITE_URL redirects nowhere, and hands out no cookie', () => {
    const unconfigured = { NODE_ENV: 'production' };
    expect(() =>
      handlePreviewExit(new Request(`http://localhost:3100${EXIT}`), {
        secure: true,
        env: unconfigured,
      }),
    ).toThrow(/SITE_URL/);
    expect(() =>
      handlePreview(new Request(`http://localhost:3100${ENTRY}`), { ...deps, env: unconfigured }),
    ).toThrow(/SITE_URL/);
  });

  it('refuses a SITE_URL that is not an http(s) URL', () => {
    expect(() =>
      handlePreviewExit(new Request(`http://localhost:3100${EXIT}`), {
        secure: true,
        env: { NODE_ENV: 'production', SITE_URL: 'javascript:alert(1)' },
      }),
    ).toThrow(/SITE_URL/);
  });

  it('in local development without SITE_URL the site is the dev server, as before', () => {
    const development = { NODE_ENV: 'development' };
    expect(
      handlePreviewExit(new Request(`http://localhost:3100${EXIT}`), {
        secure: false,
        env: development,
      }).headers.get('location'),
    ).toBe('http://localhost:3100/en-GB/pages/about');
    // …even when the request arrived on some other name: the origin is configuration, not request
    expect(
      handlePreview(new Request(`http://127.0.0.1:3100${ENTRY}`), {
        ...deps,
        env: development,
      }).headers.get('location'),
    ).toBe('http://localhost:3100/en-GB/pages/about');
  });
});
