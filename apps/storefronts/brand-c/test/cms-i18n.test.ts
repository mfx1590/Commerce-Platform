import { describe, expect, it } from 'vitest';
import { createContentContext } from '@/lib/cms/content';
import { formatReviewDate } from '@/lib/cms/format';
import { CONTENT_MESSAGES, contentMessagesFor } from '@/lib/cms/messages';

/** Same rules `test/i18n.test.ts` applies to the app catalogues, for the `content` namespace. */
function flatten(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return { [prefix]: value };
  const out: Record<string, string> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    Object.assign(out, flatten(inner, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** Brand names and symbols that are legitimately identical across languages. */
const SAME_IN_EVERY_LANGUAGE = new Set(['nav.shop', 'footer.copyright']);

describe('content messages', () => {
  const locales = Object.keys(CONTENT_MESSAGES);
  const flat = Object.fromEntries(locales.map((l) => [l, flatten(CONTENT_MESSAGES[l])]));

  it('ship for en-GB and de-DE, with identical keys', () => {
    expect(locales.sort()).toEqual(['de-DE', 'en-GB']);
    for (const locale of locales) {
      expect(Object.keys(flat[locale]!).sort()).toEqual(Object.keys(flat['en-GB']!).sort());
    }
  });

  it('use the same placeholders in every locale', () => {
    for (const [key, value] of Object.entries(flat['en-GB']!)) {
      for (const locale of locales) {
        expect(placeholders(flat[locale]![key]!), `${locale} ${key}`).toEqual(placeholders(value));
      }
    }
  });

  it('are actually translated, not copied', () => {
    const copied = Object.entries(flat['en-GB']!)
      .filter(([key, value]) => !SAME_IN_EVERY_LANGUAGE.has(key) && flat['de-DE']![key] === value)
      .map(([key]) => key);
    expect(copied).toEqual([]);
  });

  it('fall back by language, then to English', () => {
    expect(contentMessagesFor('de-DE')).toBe(CONTENT_MESSAGES['de-DE']);
    expect(contentMessagesFor('de-AT')).toBe(CONTENT_MESSAGES['de-DE']);
    expect(contentMessagesFor('en-US')).toBe(CONTENT_MESSAGES['en-GB']);
    expect(contentMessagesFor('fr-FR')).toBe(CONTENT_MESSAGES['en-GB']);
  });
});

describe('createContentContext', () => {
  it('translates with next-intl, including placeholders', () => {
    const en = createContentContext({ locale: 'en-GB' });
    const de = createContentContext({ locale: 'de-DE' });
    expect(en.t('footer.copyright', { year: 2026, store: 'Brand A' })).toBe('© 2026 Brand A');
    expect(en.t('nav.about')).toBe('About');
    expect(de.t('nav.about')).toBe('Über uns');
    expect(en.images).toBeNull();
    expect(en.preview).toBe(false);
  });
});

describe('formatReviewDate', () => {
  it('formats in the locale and echoes garbage', () => {
    expect(formatReviewDate('2026-09-01', 'en-GB')).toBe('1 September 2026');
    expect(formatReviewDate('2026-09-01', 'de-DE')).toBe('1. September 2026');
    expect(formatReviewDate('yesterday', 'en-GB')).toBe('yesterday');
  });
});
