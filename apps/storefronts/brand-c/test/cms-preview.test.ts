import { describe, expect, it } from 'vitest';
import type { CmsConfig } from '@/lib/cms/config';
import { handlePreview, handlePreviewExit } from '@/lib/cms/handlers';
import {
  PREVIEW_COOKIE,
  readCookie,
  safeRedirectPath,
  secretsMatch,
  signPreviewToken,
  verifyPreviewToken,
} from '@/lib/cms/preview';

const CONFIG: CmsConfig = {
  projectId: 'abc123',
  apiVersion: '2025-02-19',
  readToken: 'sk',
  previewSecret: 'preview-secret',
  webhookSecret: null,
};
const NOW = 1_800_000_000_000;

describe('preview token', () => {
  it('round-trips, and fails on expiry, tampering, another dataset or another secret', () => {
    const token = signPreviewToken('s', 'brand-a', NOW + 1000);
    expect(verifyPreviewToken('s', 'brand-a', token, NOW)).toBe(true);
    expect(verifyPreviewToken('s', 'brand-a', token, NOW + 1000)).toBe(false);
    expect(verifyPreviewToken('s', 'brand-b', token, NOW)).toBe(false);
    expect(verifyPreviewToken('other', 'brand-a', token, NOW)).toBe(false);
    expect(verifyPreviewToken('s', 'brand-a', `${NOW + 5000}.${token.split('.')[1]}`, NOW)).toBe(
      false,
    );
    expect(verifyPreviewToken('s', 'brand-a', 'garbage', NOW)).toBe(false);
    expect(verifyPreviewToken(null, 'brand-a', token, NOW)).toBe(false);
    expect(verifyPreviewToken('s', 'brand-a', undefined, NOW)).toBe(false);
  });

  it('never treats an unset secret as matching', () => {
    expect(secretsMatch('a', 'a')).toBe(true);
    expect(secretsMatch('a', 'b')).toBe(false);
    expect(secretsMatch(null, null)).toBe(false);
    expect(secretsMatch('', '')).toBe(false);
  });

  it('only redirects to same-site paths', () => {
    expect(safeRedirectPath('/en-GB/pages/about')).toBe('/en-GB/pages/about');
    expect(safeRedirectPath('https://evil.example')).toBe('/');
    expect(safeRedirectPath('//evil.example')).toBe('/');
    expect(safeRedirectPath('/\\evil.example')).toBe('/');
    expect(safeRedirectPath(null)).toBe('/');
  });

  it('rejects control characters a URL parser would strip before parsing (#277)', () => {
    // WHATWG URL parsing removes tab, newline and CR, so `/\t/evil.example` resolves off-origin
    // even though it starts with a single slash. The shared rule refuses them outright.
    for (const controlPath of [
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r/evil.example',
      '/\u0000/evil.example',
      '/\u007f/evil.example',
      '/\u{2028}/evil.example',
      '/\u{2029}/evil.example',
    ]) {
      expect(safeRedirectPath(controlPath), JSON.stringify(controlPath)).toBe('/');
    }
    // and the browser-resolution proof of the original exploit shape:
    expect(new URL('/\t/evil.example', 'https://shop.example').origin).toBe('https://evil.example');
  });
});

describe('handlePreview', () => {
  const deps = { config: CONFIG, dataset: 'brand-a', secure: true, now: () => NOW };
  const url = (query: string) => new Request(`http://localhost:3100/api/cms/preview?${query}`);

  it('sets a verifiable httpOnly cookie and redirects on the right secret', () => {
    const response = handlePreview(url('secret=preview-secret&redirect=/en-GB/pages/about'), deps);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3100/en-GB/pages/about');
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Secure/);
    const token = readCookie(cookie.split(';')[0] ?? '', PREVIEW_COOKIE);
    expect(verifyPreviewToken('preview-secret', 'brand-a', token, NOW)).toBe(true);
  });

  it('rejects a wrong or missing secret with 401 and no cookie', () => {
    for (const query of ['secret=nope', '', 'secret=']) {
      const response = handlePreview(url(query), deps);
      expect(response.status).toBe(401);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  });

  it('answers 503 when preview cannot work: no secret, no read token, or no store', () => {
    expect(
      handlePreview(url('secret=x'), { ...deps, config: { ...CONFIG, previewSecret: null } })
        .status,
    ).toBe(503);
    expect(
      handlePreview(url('secret=x'), { ...deps, config: { ...CONFIG, readToken: null } }).status,
    ).toBe(503);
    expect(handlePreview(url('secret=x'), { ...deps, dataset: null }).status).toBe(503);
  });

  it('exit clears the cookie and redirects safely', () => {
    const response = handlePreviewExit(
      new Request('http://localhost:3100/api/cms/preview/exit?redirect=https://evil.example'),
      { secure: false },
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3100/');
    expect(response.headers.get('set-cookie')).toMatch(/^cms_preview=; .*Max-Age=0/);
    expect(response.headers.get('set-cookie')).not.toMatch(/Secure/);
  });

  it('the unauthenticated exit cannot be used as an open redirect (#277 exploit shape)', () => {
    // %2F%09%2F decodes to "/\t/": a bare "starts with /" check passes it, the browser resolves it
    // to https://evil.example. Both layers must hold: the string rule and the resolved origin.
    for (const query of [
      'redirect=%2F%09%2Fevil.example',
      'redirect=%2F%0A%2Fevil.example',
      'redirect=%2F%0D%2Fevil.example',
    ]) {
      const response = handlePreviewExit(
        new Request(`http://localhost:3100/api/cms/preview/exit?${query}`),
        { secure: false },
      );
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get('location')!);
      expect(location.origin, query).toBe('http://localhost:3100');
      expect(location.pathname).toBe('/');
      // the cookie is still cleared — a failed redirect target must not keep preview alive
      expect(response.headers.get('set-cookie')).toMatch(/^cms_preview=; .*Max-Age=0/);
    }
  });

  it('every preview redirect lands on the request origin, entry included', () => {
    const entry = handlePreview(url('secret=preview-secret&redirect=%2F%09%2Fevil.example'), deps);
    expect(entry.status).toBe(307);
    expect(new URL(entry.headers.get('location')!).origin).toBe('http://localhost:3100');
    expect(new URL(entry.headers.get('location')!).pathname).toBe('/');
  });
});
