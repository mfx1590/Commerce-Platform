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
const frameSrc = Object.values(EMBED_HOSTS)
  .flat()
  .map((host) => `https://${host}`);

/**
 * Content Security Policy.
 *
 * This is the **second** layer under campaign embeds, not the first: window 6 sandboxes every embed
 * iframe, and that is what contains a hostile page. The CSP stops an embed being pointed at a host
 * nobody reviewed in the first place — an editor pasting an arbitrary URL, or a compromised CMS
 * document — which sandboxing alone does not.
 *
 * **Known limitation, stated rather than implied:** `script-src` still needs `'unsafe-inline'`.
 * Next's App Router emits inline bootstrap and flight-data scripts, and the only way to drop that is
 * a per-request nonce threaded through the middleware and every `<Script>`. Until then this policy
 * is worth having for what it does enforce — framing, plugins, form targets, base URI — but it is
 * **not** XSS protection, and no one should treat it as such.
 */
const csp = [
  "default-src 'self'",
  // Images come from the CDNs `remotePatterns` already allows, plus data: for inlined placeholders.
  "img-src 'self' data: blob: https://res.cloudinary.com https://images.unsplash.com https://picsum.photos",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  // The storefront talks to its own origin; the Store API is called server-side, never from here.
  "connect-src 'self'",
  `frame-src 'self' ${frameSrc.join(' ')}`,
  // Nothing may frame us: clickjacking a checkout is the attack this prevents.
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  // A form on our page may only post to us — an injected form cannot exfiltrate a filled address.
  "form-action 'self'",
  'upgrade-insecure-requests',
].join('; ');

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
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
          { key: 'Content-Security-Policy', value: csp },
          // Belt and braces with `frame-ancestors`, for anything that predates CSP support.
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
