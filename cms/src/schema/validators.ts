import { SANITY_API_VERSION } from '../datasets.js';
import type { CustomValidator } from './define.js';

/**
 * A document's address is `(type, locale, slug)`; two published documents must never share one,
 * or the storefront's `/[locale]/pages/[slug]` route would pick an arbitrary winner. Sanity has no
 * unique constraint, so this queries the dataset from the Studio (`context.getClient`) and skips
 * silently where no client exists (tests without one, or a partially filled document).
 */
export const uniqueLocaleSlug: CustomValidator = async (value, context) => {
  const slug = (value as { current?: string } | undefined)?.current;
  const document = context.document;
  if (!slug || !document || !context.getClient) return true;

  const id = String(document['_id'] ?? '').replace(/^drafts\./, '');
  const client = context.getClient({ apiVersion: SANITY_API_VERSION });
  const existing = await client.fetch<string | null>(
    `*[_type == $type && locale == $locale && slug.current == $slug && !(_id in [$id, $draftId])][0]._id`,
    {
      type: document['_type'],
      locale: document['locale'],
      slug,
      id,
      draftId: `drafts.${id}`,
    },
  );
  return existing
    ? `Another ${String(document['_type'])} already uses /${String(document['locale'])}/${slug}`
    : true;
};

/** `endsAt` must come after `startsAt` when both are set. */
export const endsAfterStart: CustomValidator = (value, context) => {
  const startsAt = context.document?.['startsAt'];
  if (typeof value !== 'string' || typeof startsAt !== 'string') return true;
  return Date.parse(value) > Date.parse(startsAt) ? true : 'Must end after it starts';
};
