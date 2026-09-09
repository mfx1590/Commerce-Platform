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
} as const;
