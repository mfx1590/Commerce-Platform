'use client';

import { cloudinaryImageLoader, isCloudinaryUrl } from '@platform/ui/image-loader';
import Image, { type ImageProps } from 'next/image';

/**
 * `next/image` with the image CDN as the loader hook (task 2.3; the loader itself is REQUEST #169).
 *
 * - A **Cloudinary delivery URL** — what window 9's media pipeline produces — is resized by
 *   Cloudinary (`c_limit,w_<width>,q_…,f_auto`) and fetched by the browser straight from the CDN,
 *   rather than proxied through this server.
 * - **Anything else** keeps Next's default loader, so it still goes through the built-in optimiser
 *   and `remotePatterns` still decides which hosts may be optimised.
 *
 * Why a client component and not a global `images.loaderFile`: a custom loader file switches the
 * whole app to `loader: 'custom'`, and Next then **disables `/_next/image` entirely** — every
 * non-Cloudinary image (seed thumbnails, Unsplash) would 404 rather than fall back. Verified, not
 * assumed. And why not a `loader` prop from the page: `next/image` is itself a client component, and
 * a function cannot cross the server → client boundary. Choosing the loader here, on the client
 * side of that boundary, is the one seam that keeps both paths working.
 *
 * Pages pass only serialisable props, exactly as they would to `next/image`.
 */
export function ProductImage(props: ImageProps) {
  const src = typeof props.src === 'string' ? props.src : undefined;
  return src !== undefined && isCloudinaryUrl(src) ? (
    <Image {...props} loader={cloudinaryImageLoader} />
  ) : (
    <Image {...props} />
  );
}
