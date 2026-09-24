import type { MetadataRoute } from 'next';
import { absoluteUrl } from '@/lib/seo';

/**
 * `/robots.txt`.
 *
 * The disallow list is the funnel and the account area: those pages are per-customer, carry no
 * content worth ranking, and a crawler following a cart link would spend its budget creating carts.
 * `/api/` and `/auth/` are machinery. Everything else — catalogue, content, campaign landings — is
 * meant to be found.
 *
 * A non-production deployment refuses everything. A staging site that leaks into an index outranks
 * the real one for its own brand name and is slow to undo.
 */
export default function robots(): MetadataRoute.Robots {
  const indexable = process.env.ROBOTS_ALLOW_INDEXING === '1' || isProductionSite();

  if (!indexable) {
    return { rules: [{ userAgent: '*', disallow: '/' }] };
  }

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/auth/', '/*/cart', '/*/checkout/', '/*/account', '/*/orders/'],
      },
    ],
    sitemap: absoluteUrl('/sitemap.xml'),
    host: absoluteUrl(''),
  };
}

/**
 * Indexing is opt-in by environment rather than by hostname guessing: `SITE_URL` is set on every
 * deployment, and a preview URL is exactly the case that must not be indexed.
 */
function isProductionSite(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.VERCEL_ENV !== 'preview';
}
