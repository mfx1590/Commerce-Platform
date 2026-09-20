import type { Seo } from '@platform/cms';
import { cloudinaryImageLoader, isCloudinaryUrl } from '@platform/ui';
import type { Metadata } from 'next';
import { routing } from '@/i18n/routing';
import type { ContentContext } from './content';
import { sanityImageUrl } from './components/sanity-image';

/**
 * `generateMetadata` for a CMS document: the SEO fields with the document title as fallback,
 * `noIndex` as a robots directive, the share image, and the canonical / hreflang pair the root
 * layout also emits (one URL per locale, same path). Works with window 3's 2.2 metadata task
 * because everything here is additive to the root layout's `title.template` and `metadataBase`.
 */
export function documentMetadata(
  document: { title: string; seo?: Seo | undefined },
  path: string,
  ctx: ContentContext,
): Metadata {
  const seo = document.seo;
  const metadata: Metadata = {
    title: seo?.metaTitle ?? document.title,
    alternates: {
      canonical: `/${ctx.locale}${path}`,
      languages: Object.fromEntries(routing.locales.map((l) => [l, `/${l}${path}`])),
    },
  };
  if (seo?.metaDescription) metadata.description = seo.metaDescription;
  if (seo?.noIndex) metadata.robots = { index: false, follow: false };
  const image = shareImageUrl(seo, ctx);
  if (image) metadata.openGraph = { images: [{ url: image, alt: seo!.ogImage!.alt }] };
  return metadata;
}

/** The share image from either source: Cloudinary (via the shared loader) wins, then the Sanity asset. */
function shareImageUrl(seo: Seo | undefined, ctx: ContentContext): string | null {
  const ogImage = seo?.ogImage;
  if (!ogImage) return null;
  const cloudinary = ogImage.cloudinaryUrl?.trim();
  if (cloudinary && isCloudinaryUrl(cloudinary)) {
    return cloudinaryImageLoader({ src: cloudinary, width: 1200 });
  }
  if (ogImage.asset && ctx.images) {
    return sanityImageUrl(ctx.images, ogImage.asset._ref, { width: 1200 });
  }
  return null;
}
