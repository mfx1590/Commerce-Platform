import deDE from './de-DE.json';
import enGB from './en-GB.json';

/**
 * The `content` namespace: every string the `(content)` routes and the CMS components render that
 * does not come from the CMS itself. Owned by window 6 so a new string never needs a change to
 * window 3's catalogues; REQUEST #178 merges it into the app-wide messages as well.
 *
 * Nested objects, addressed with dot keys (`t('nav.shop')`) exactly like next-intl's catalogues.
 */
export type ContentMessages = typeof enGB;

export const CONTENT_MESSAGES: Record<string, ContentMessages> = {
  'en-GB': enGB,
  'de-DE': deDE,
};

export const CONTENT_FALLBACK_LOCALE = 'en-GB';

/** The catalogue for a locale, falling back to the base language and then to English. */
export function contentMessagesFor(locale: string): ContentMessages {
  const exact = CONTENT_MESSAGES[locale];
  if (exact) return exact;
  const language = locale.split('-')[0];
  const sameLanguage = Object.entries(CONTENT_MESSAGES).find(([l]) => l.split('-')[0] === language);
  return sameLanguage?.[1] ?? CONTENT_MESSAGES[CONTENT_FALLBACK_LOCALE]!;
}
