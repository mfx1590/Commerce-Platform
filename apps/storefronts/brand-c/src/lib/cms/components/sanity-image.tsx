import type { SanityImage as SanityImageValue } from '@platform/cms';
import { cloudinaryImageLoader, isCloudinaryUrl } from '@platform/ui';
import type { ContentContext } from '../content';

/**
 * One component for every CMS image, with two sources (task 2.5):
 *
 * - **Cloudinary** (`image.cloudinaryUrl`): responsive `srcset` built with the shared
 *   `cloudinaryImageLoader` from `@platform/ui` (window 9's loader; transformation URLs are never
 *   hand-rolled here). A URL the loader does not recognise falls back to the source URL unchanged,
 *   with no srcset — exactly what the loader itself does. When set, Cloudinary wins over the
 *   Sanity asset.
 * - **Sanity upload** (`image.asset`): the asset ref `image-<id>-<w>x<h>-<format>` encodes the URL
 *   and intrinsic size, so no second query; srcset uses the Sanity CDN's own `w=` parameter.
 *
 * Alt text is schema-required for both. `next/image` is not used on purpose: the pages are server
 * components tested without a DOM, and both CDNs do the actual resizing.
 */

/** Device-width steps both CDNs serve; the browser picks via `sizes`. */
export const IMAGE_WIDTHS = [384, 640, 828, 1080, 1200, 1600] as const;

const DEFAULT_SIZES = '(min-width: 768px) 768px, 100vw';

export interface AssetRef {
  id: string;
  width: number;
  height: number;
  format: string;
}

export function parseAssetRef(ref: string): AssetRef | null {
  const match = /^image-([A-Za-z0-9_-]+)-(\d+)x(\d+)-([a-z0-9]+)$/.exec(ref);
  if (!match) return null;
  return {
    id: match[1]!,
    width: Number(match[2]),
    height: Number(match[3]),
    format: match[4]!,
  };
}

export function sanityImageUrl(
  source: { projectId: string; dataset: string },
  ref: string,
  options: { width?: number } = {},
): string | null {
  const asset = parseAssetRef(ref);
  if (!asset) return null;
  const url = new URL(
    `https://cdn.sanity.io/images/${source.projectId}/${source.dataset}/${asset.id}-${asset.width}x${asset.height}.${asset.format}`,
  );
  url.searchParams.set('auto', 'format');
  url.searchParams.set('fit', 'max');
  if (options.width) url.searchParams.set('w', String(options.width));
  return url.toString();
}

/** `srcset` over the width steps; `build` returns the URL for one width. */
function srcSetFrom(build: (width: number) => string): string {
  return IMAGE_WIDTHS.map((width) => `${build(width)} ${width}w`).join(', ');
}

export interface SanityImageProps {
  image: SanityImageValue;
  ctx: ContentContext;
  /** Rendered width hint for the CDN; the intrinsic size still comes from the asset. */
  width?: number;
  sizes?: string;
  className?: string;
  priority?: boolean;
}

export function SanityImage({
  image,
  ctx,
  width = 1200,
  sizes = DEFAULT_SIZES,
  className,
  priority,
}: SanityImageProps) {
  const shared = {
    alt: image.alt,
    loading: priority ? ('eager' as const) : ('lazy' as const),
    decoding: 'async' as const,
    className,
    sizes,
  };

  const cloudinary = image.cloudinaryUrl?.trim();
  if (cloudinary) {
    // The renderer does not trust stored data (same rule as safeHref): https only.
    if (!/^https:\/\//.test(cloudinary)) return null;
    if (!isCloudinaryUrl(cloudinary)) {
      // Falls back to the source URL untouched — a moved or non-Cloudinary image still shows.
      return <img src={cloudinary} {...shared} sizes={undefined} />;
    }
    return (
      <img
        src={cloudinaryImageLoader({ src: cloudinary, width })}
        srcSet={srcSetFrom((w) => cloudinaryImageLoader({ src: cloudinary, width: w }))}
        {...shared}
      />
    );
  }

  const ref = image.asset?._ref;
  const asset = ref ? parseAssetRef(ref) : null;
  const src = asset && ctx.images ? sanityImageUrl(ctx.images, ref!, { width }) : null;
  if (!asset || !src) return null;
  return (
    <img
      src={src}
      srcSet={srcSetFrom((w) => sanityImageUrl(ctx.images!, ref!, { width: w })!)}
      width={asset.width}
      height={asset.height}
      {...shared}
    />
  );
}
