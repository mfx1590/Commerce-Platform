import { describe, expect, it } from 'vitest';
import {
  HREF_PATTERN,
  footerFixture,
  navigationFixture,
  schemaTypes,
  uniqueLocale,
  uniqueLocaleKey,
  validateDocument,
} from '../src/index.js';
import type { ValidationClient } from '../src/index.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('href rule', () => {
  it('accepts storefront paths and https URLs only', () => {
    for (const ok of [
      '/',
      '/products',
      '/en-GB/pages/about?x=1',
      'https://instagram.com/brand-a',
    ]) {
      expect(HREF_PATTERN.test(ok), ok).toBe(true);
    }
    for (const bad of [
      '//evil.example',
      'http://plain.example',
      'javascript:alert(1)',
      'mailto:x@y.z',
      'products',
      'https://',
      '',
    ]) {
      expect(HREF_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it('is what the schema enforces on every link-like field', async () => {
    const nav = clone(navigationFixture);
    nav.items[0]!.href = '//evil.example';
    nav.items[1]!.children![0]!.href = 'http://plain.example';
    const errors = await validateDocument(nav as unknown as Record<string, unknown>, schemaTypes);
    expect(errors.map((e) => e.path).sort()).toEqual([
      'items[0].href',
      'items[1].children[0].href',
    ]);
    expect(errors[0]?.message).toBe('Must match a storefront path (/…) or an https:// URL');
  });
});

describe('navigation and footer uniqueness', () => {
  const clientReturning =
    (existing: string | null, seen: Record<string, unknown>[] = []) =>
    (): ValidationClient => ({
      fetch: async (_query, params) => {
        seen.push(params ?? {});
        return existing as never;
      },
    });

  it('rejects a second main menu for the same locale, by key', async () => {
    const params: Record<string, unknown>[] = [];
    const errors = await validateDocument(
      navigationFixture as unknown as Record<string, unknown>,
      schemaTypes,
      { getClient: clientReturning('navigation.en-GB.main-2', params) },
    );
    expect(errors).toEqual([
      { path: 'key', message: 'Another navigation already uses key "main" in en-GB' },
    ]);
    expect(params[0]).toMatchObject({ type: 'navigation', locale: 'en-GB', own: 'main' });
  });

  it('rejects a second footer for the same locale', async () => {
    const errors = await validateDocument(
      footerFixture as unknown as Record<string, unknown>,
      schemaTypes,
      { getClient: clientReturning('footer.en-GB.other') },
    );
    expect(errors).toEqual([
      { path: 'locale', message: 'Another footer already exists for en-GB' },
    ]);
  });

  it('passes without a client, and when nothing else exists', async () => {
    expect(await uniqueLocaleKey('main', { document: navigationFixture as never })).toBe(true);
    expect(
      await uniqueLocale('en-GB', {
        document: footerFixture as never,
        getClient: clientReturning(null),
      }),
    ).toBe(true);
    expect(
      await validateDocument(navigationFixture as unknown as Record<string, unknown>, schemaTypes, {
        getClient: clientReturning(null),
      }),
    ).toEqual([]);
  });
});
