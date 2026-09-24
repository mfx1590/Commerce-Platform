import { EMBED_HOSTS } from '@platform/cms';
import createNextIntlPlugin from 'next-intl/plugin';

/**
 * Plain ESM on purpose, not TypeScript: `next start` loads this file at **runtime**, and loading a
 * `.ts` config needs the `typescript` package. That is a devDependency, so the production image
 * (built with `pnpm deploy --prod`) does not have it and the container fails to boot (REQUEST #68).
 */

/**
 * Hosts whose pages may be framed on a campaign landing (REQUEST #199).
 *
 * Imported from `@platform/cms` rather than copied: `EMBED_HOSTS` is what window 6's Studio
 * validates an editor's embed URL against, and a CSP listing different hosts would either block an
 * embed the Studio accepted or permit one it rejected. One list, two enforcement points.
 */
const frameHosts = Object.values(EMBED_HOSTS)
  .flat()
  .map((host) => `https://${host}`)
  .join(' ');

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Build-time constant on purpose: the embed host list is code (window 6's), not environment, so
  // it is fixed here and handed to the middleware, which builds the rest of the policy at runtime.
  env: { CSP_FRAME_HOSTS: frameHosts },
  // The kit ships as TypeScript-compiled ESM; Next must transpile it like app code.
  transpilePackages: ['@platform/ui'],
  images: {
    // Product media comes from the CDN, not from the app. This list is a security boundary: an
    // unlisted host cannot be rendered through the optimiser, so each entry is as narrow as the
    // media it has to serve.
    remotePatterns: [
      { protocol: 'https', hostname: 'res.cloudinary.com' },
      { protocol: 'https', hostname: 'images.unsplash.com' },
      // The development seed's product thumbnails (packages/db seed:
      // `https://picsum.photos/seed/<store>-<n>/800/1000`). Scoped to `/seed/**` rather than the
      // whole host: without it the PLP cannot render against the core at all, and with a wider
      // entry the optimiser would proxy arbitrary picsum paths.
      { protocol: 'https', hostname: 'picsum.photos', pathname: '/seed/**' },
    ],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // The Content-Security-Policy is NOT here: it depends on KEYCLOAK_URL, which differs per
          // deployment, and headers() is baked at build time. See src/lib/csp.ts and the middleware.
          // Belt and braces with the CSP's `frame-ancestors`, for anything predating CSP support.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Send the origin cross-site, the full path same-site: enough for our own analytics,
          // never enough to leak a checkout URL's contents to a third party.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // The storefront asks for none of these; saying so stops an embed asking on our behalf.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
  eslint: {
    // Linting is a repo-level job (`pnpm lint` with the root flat config), not a build step.
    ignoreDuringBuilds: true,
  },
};

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

export default withNextIntl(config);
