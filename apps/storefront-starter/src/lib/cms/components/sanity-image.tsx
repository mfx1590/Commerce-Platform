import type { SanityImage as SanityImageValue } from '@platform/cms';
import type { ContentContext } from '../content';

/**
 * Sanity image references encode everything needed for a URL — `image-<id>-<w>x<h>-<format>` —
 * so no second query is needed to render one. Task 2.5 replaces the `<img>` with the Cloudinary
 * loader and responsive `srcset`; the URL builder and the alt-text contract stay.
 */

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

export interface SanityImageProps {
  image: SanityImageValue;
  ctx: ContentContext;
  /** Rendered width hint for the CDN; the intrinsic size still comes from the asset. */
  width?: number;
  className?: string;
  priority?: boolean;
}

export function SanityImage({ image, ctx, width = 1200, className, priority }: SanityImageProps) {
  const asset = parseAssetRef(image.asset._ref);
  const src = ctx.images ? sanityImageUrl(ctx.images, image.asset._ref, { width }) : null;
  if (!asset || !src) return null;
  return (
    <img
      src={src}
      alt={image.alt}
      width={asset.width}
      height={asset.height}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      className={className}
    />
  );
}
