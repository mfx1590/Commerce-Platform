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
 * **Indexing is an explicit opt-in: `ROBOTS_ALLOW_INDEXING=1`, set on the production deployment
 * only.** Everything else — staging, previews, a laptop — tells crawlers to stay out. A staging site
 * that leaks into an index outranks the real one for its own brand name and takes weeks to undo; a
 * production site that forgot the variable is noticed the same day. The asymmetry decides the
 * default.
 *
 * Rendered **per request**, not at build time. As a static route it was baked into the image by
 * `next build`, which always runs with `NODE_ENV=production` — so the earlier "refuse outside
 * production" check could never fire and every image, staging included, said `Allow: /`. Found by
 * reading the built `.next/server/app/robots.txt.body`, not by review.
 */
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  if (process.env.ROBOTS_ALLOW_INDEXING !== '1') {
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
