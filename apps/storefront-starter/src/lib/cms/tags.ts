/**
 * Cache tags for CMS reads, from coarse to fine. Every published read carries all three levels, so
 * the publish webhook can revalidate one document, one type, or everything.
 *
 *   cms                          — everything from the CMS
 *   cms:page                     — every page
 *   cms:page:en-GB:about         — one document (slug, or `key` for navigation)
 */
export const cmsTags = {
  all: 'cms',
  type: (type: string): string => `cms:${type}`,
  document: (type: string, locale: string, slugOrKey: string): string =>
    `cms:${type}:${locale}:${slugOrKey}`,
} as const;

/**
 * Published content is not personalised and a publish revalidates it by tag, so the interval only
 * bounds staleness if a webhook is ever lost.
 */
export const CMS_REVALIDATE_SECONDS = 300;
