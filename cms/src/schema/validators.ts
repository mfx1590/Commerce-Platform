import { SANITY_API_VERSION } from '../datasets.js';
import type { CustomValidator } from './define.js';

/**
 * A document's address is `(type, locale, slug)` — or `(type, locale, key)` for navigation menus,
 * and `(type, locale)` alone for the footer. Two published documents must never share one, or the
 * storefront's `/[locale]/pages/[slug]` route (and the nav/footer reads) would pick an arbitrary
 * winner. Sanity has no unique constraint, so these query the dataset from the Studio
 * (`context.getClient`) and skip silently where no client exists (tests without one, or a
 * partially filled document).
 */
function uniqueWithin(discriminator: 'slug' | 'key' | null): CustomValidator {
  return async (value, context) => {
    const document = context.document;
    if (!document || !context.getClient) return true;
    const locale = document['locale'];
    const own =
      discriminator === 'slug'
        ? (value as { current?: string } | undefined)?.current
        : discriminator === 'key'
          ? (value as string | undefined)
          : (value as string | undefined); // the locale field itself
    if (!own || !locale) return true;

    const condition =
      discriminator === 'slug'
        ? ' && slug.current == $own'
        : discriminator === 'key'
          ? ' && key == $own'
          : '';
    const id = String(document['_id'] ?? '').replace(/^drafts\./, '');
    const client = context.getClient({ apiVersion: SANITY_API_VERSION });
    const existing = await client.fetch<string | null>(
      `*[_type == $type && locale == $locale${condition} && !(_id in [$id, $draftId])][0]._id`,
      { type: document['_type'], locale, own, id, draftId: `drafts.${id}` },
    );
    if (!existing) return true;
    const type = String(document['_type']);
    if (discriminator === 'slug') return `Another ${type} already uses /${String(locale)}/${own}`;
    if (discriminator === 'key')
      return `Another ${type} already uses key "${own}" in ${String(locale)}`;
    return `Another ${type} already exists for ${String(locale)}`;
  };
}

/** `slug` fields: unique per (type, locale). */
export const uniqueLocaleSlug: CustomValidator = uniqueWithin('slug');
/** `navigation.key`: one `main` and one `utility` menu per locale. */
export const uniqueLocaleKey: CustomValidator = uniqueWithin('key');
/** `footer.locale`: one footer per locale. */
export const uniqueLocale: CustomValidator = uniqueWithin(null);

/** `endsAt` must come after `startsAt` when both are set. */
export const endsAfterStart: CustomValidator = (value, context) => {
  const startsAt = context.document?.['startsAt'];
  if (typeof value !== 'string' || typeof startsAt !== 'string') return true;
  return Date.parse(value) > Date.parse(startsAt) ? true : 'Must end after it starts';
};
