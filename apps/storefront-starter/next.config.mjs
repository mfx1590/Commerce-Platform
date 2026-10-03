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

/**
 * End-to-end builds only (#327): `scripts/e2e-server.mjs` sets it for `next build`, and it is
 * inlined below so `ProductImage` (a client component) can send remote images to a local
 * placeholder. A build made with it refuses to start outside a loopback origin
 * (`src/instrumentation.ts`). Exactly `1` or nothing.
 */
const localImages = process.env.E2E_LOCAL_IMAGES === '1' ? '1' : '';

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Metadata blocks for every user agent, not only the crawlers on Next's default list (#274).
  // Since 15.2 `generateMetadata` is streamed for anyone the pattern does not match, and streamed
  // metadata is written after `</head>` has closed: title, description, canonical and the
  // `hreflang` alternates end up in `<body>`, where Google ignores `hreflang` and Lighthouse finds
  // no description. The default list leaves out browsers, Lighthouse and Googlebot itself, so
  // extending it name by name would fix whichever reader we thought of and no other. The cost is
  // that the first byte waits for `generateMetadata` — which awaits the same cached reads the page
  // needs before it can render anything. Held by test/seo-head.test.ts and e2e/seo-head.spec.ts.
  // A request with no User-Agent header never reaches this pattern; the middleware covers it.
  htmlLimitedBots: /.*/,
  // Build-time constant on purpose: the embed host list is code (window 6's), not environment, so
  // it is fixed here and handed to the middleware, which builds the rest of the policy at runtime.
  env: { CSP_FRAME_HOSTS: frameHosts, E2E_LOCAL_IMAGES: localImages },
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
