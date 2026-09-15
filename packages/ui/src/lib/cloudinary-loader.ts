/**
 * A `next/image` loader for Cloudinary-delivered media (REQUEST #169, window 9).
 *
 * Storefronts render product media at many sizes from one stored URL: the core keeps returning
 * `product_media.url` unchanged and each storefront derives the size it needs through this loader
 * and a responsive `sizes`, rather than the core minting a fixed rendition per layout.
 *
 * Deliberately generic: no cloud name, account or environment is baked in. The cloud name is
 * whatever the delivery URL already carries, so the same function works for every brand.
 *
 * Pure, dependency-free and framework-neutral, so it is usable as `<Image loader={…}>`, as the
 * global `images.loader` in a storefront's `next.config`, or on its own in a test.
 */

/**
 * A Cloudinary delivery URL: `https://res.cloudinary.com/<cloud>/<image|video|raw>/upload/...`.
 *
 * Matching the delivery host here is a convenience, not a security control — `next.config`
 * `remotePatterns` is what actually decides which hosts may be optimised. This only decides whether
 * a transformation can be inserted at all.
 */
const CLOUDINARY_DELIVERY = /^https:\/\/res\.cloudinary\.com\/[^/]+\/(?:image|video|raw)\/upload\//;

export function isCloudinaryUrl(src: string): boolean {
  return CLOUDINARY_DELIVERY.test(src);
}

export interface CloudinaryLoaderParams {
  src: string;
  width: number;
  /** `next/image` passes a number; anything falsy becomes Cloudinary's own `q_auto`. */
  quality?: number | undefined;
}

/**
 * Insert `c_limit,w_<width>,q_<quality|auto>,f_auto` immediately after `/upload/`.
 *
 * `c_limit` never enlarges an image past its stored size, so a narrow viewport cannot ask Cloudinary
 * to upscale; `f_auto` negotiates the format per browser. The segment is chained **before** any
 * transformation already in the URL (Cloudinary applies chained components left to right), so an
 * art-directed crop stored with the asset still runs — on an image already limited to the width
 * this layout asked for.
 *
 * A URL that is not a Cloudinary delivery URL is returned unchanged, which is what makes this safe
 * as a global loader: the seed's `picsum.photos` thumbnails and any other host pass straight
 * through to `remotePatterns`.
 */
export function transformUrl(src: string, width: number, quality?: number | undefined): string {
  if (!isCloudinaryUrl(src)) return src;

  const transformation = `c_limit,w_${width},q_${quality ?? 'auto'},f_auto`;
  return src.replace(/\/upload\//, `/upload/${transformation}/`);
}

export function cloudinaryImageLoader({ src, width, quality }: CloudinaryLoaderParams): string {
  return transformUrl(src, width, quality);
}
