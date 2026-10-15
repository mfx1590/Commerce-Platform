import type { ImageLoader } from 'next/image';

/**
 * Local images for the end-to-end run (#327): with the flag set, no product image leaves the
 * machine.
 *
 * The development seed's thumbnails are `https://picsum.photos/seed/…` URLs. Through the image
 * optimiser each one made the server fetch from the public internet and resize at every srcset
 * width, and a slow picsum held pages open long enough to fail the suite (three passes 84/3, 87/0,
 * 82/5). `images.unoptimized` alone would not help: it moves the same fetch to the browser. So under
 * the flag **every remote image** — picsum, and the CDN hosts as well — resolves to one placeholder
 * served by this app. Local paths are left alone.
 *
 * The flag is a **build-time** constant: `scripts/e2e-server.mjs` sets it for `next build`, and
 * `next.config.mjs` inlines it, so the client component that picks the loader can read it. A build
 * made with it must never serve real customers, so `assertLocalImagesAllowed` refuses to boot it
 * anywhere but a loopback origin (`src/instrumentation.ts`). `NODE_ENV` cannot draw that line:
 * the e2e server is `next build` + `next start`, which is `production` too.
 */
export const LOCAL_IMAGES_FLAG = 'E2E_LOCAL_IMAGES';

/** The one image every remote `src` becomes under the flag. Served from `public/`. */
export const LOCAL_PLACEHOLDER = '/e2e-placeholder.svg';

/**
 * Was this build made with local images? Reads the inlined value; `process.env.E2E_LOCAL_IMAGES`
 * is written out literally because Next replaces exactly that expression at build time.
 */
export function localImagesEnabled(value: string | undefined = process.env.E2E_LOCAL_IMAGES) {
  return value === '1';
}

/** An absolute http(s) URL, i.e. something the browser or the optimiser would fetch from afar. */
export function isRemoteImage(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

/**
 * The placeholder at the requested width. The width is carried in the query so each srcset entry
 * stays distinct (and `next/image` sees a loader that honours it); the SVG scales to any of them.
 */
export const localPlaceholderLoader: ImageLoader = ({ width }) => `${LOCAL_PLACEHOLDER}?w=${width}`;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Throws when a build made with local images is started anywhere but a loopback origin.
 *
 * "Production" here is the place the server runs, which only the runtime `SITE_URL` says: the
 * image is built once and promoted (#302), and a real deployment always sets `SITE_URL` to its
 * public origin. Missing or unparsable counts as not allowed — fail closed.
 */
export function assertLocalImagesAllowed(enabled: boolean, siteUrl: string | undefined): void {
  if (!enabled) return;
  let host: string | undefined;
  try {
    host = siteUrl === undefined ? undefined : new URL(siteUrl).hostname;
  } catch {
    host = undefined;
  }
  if (host === undefined || !LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `${LOCAL_IMAGES_FLAG} is an end-to-end test build and must not be set in production: ` +
        `it replaces every product image with a placeholder. This server's SITE_URL is not a ` +
        `loopback origin, so it refuses to start. Rebuild without ${LOCAL_IMAGES_FLAG}.`,
    );
  }
}
