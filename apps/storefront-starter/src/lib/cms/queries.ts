import type {
  CampaignLandingDocument,
  FooterDocument,
  LegalDocument,
  NavigationDocument,
  PageDocument,
} from '@platform/cms';
import { defineQuery } from './client';

/**
 * One query per read. Every routed document is addressed by `(type, locale, slug)` — the
 * uniqueness the schema enforces — and the newest wins if two ever collide, so the storefront never
 * picks at random. Documents are returned whole (`...`): image assets stay references, which the
 * Cloudinary/Sanity image loader (task 2.5) resolves from the ref without a second query.
 */

/**
 * The `page` that fills the home page (`HomeContent`). `/pages/home` renders it too, so listing it
 * would advertise a duplicate of `/`.
 */
export const HOME_SLUG = 'home';

/** A `routedDocuments` row as Sanity answers it: a projected attribute that is missing is `null`. */
export interface RoutedDocumentRow {
  type: string;
  slug: string | null;
  startsAt: string | null;
  endsAt: string | null;
}

const bySlug = (type: string) =>
  `*[_type == "${type}" && locale == $locale && slug.current == $slug] | order(_updatedAt desc)[0]`;

export const queries = {
  page: defineQuery<PageDocument | null>(bySlug('page')),
  campaignLanding: defineQuery<CampaignLandingDocument | null>(bySlug('campaignLanding')),
  legal: defineQuery<LegalDocument | null>(bySlug('legal')),
  navigation: defineQuery<NavigationDocument | null>(
    `*[_type == "navigation" && locale == $locale && key == $key] | order(_updatedAt desc)[0]`,
  ),
  footer: defineQuery<FooterDocument | null>(
    `*[_type == "footer" && locale == $locale] | order(_updatedAt desc)[0]`,
  ),
  /** Slugs of every page in a locale — for `generateStaticParams` and sitemaps. */
  pageSlugs: defineQuery<string[]>(`*[_type == "page" && locale == $locale].slug.current`),
  legalSlugs: defineQuery<string[]>(`*[_type == "legal" && locale == $locale].slug.current`),
  /**
   * Every routed, indexable document in a locale — for the sitemap (#300). Newest first, so the
   * reader keeps the document the by-slug reads would render if two ever collide.
   *
   * `coalesce` on purpose: most documents have no `seo` object, and a filter that compares the
   * missing flag directly (`seo.noIndex == false`) drops every one of them.
   */
  routedDocuments: defineQuery<RoutedDocumentRow[]>(
    `*[_type in ["page", "legal", "campaignLanding"] && locale == $locale && defined(slug.current)` +
      ` && coalesce(seo.noIndex, false) == false` +
      ` && !(_type == "page" && slug.current == $home)]` +
      ` | order(_updatedAt desc)` +
      ` { "type": _type, "slug": slug.current, startsAt, endsAt }`,
  ),
} as const;
