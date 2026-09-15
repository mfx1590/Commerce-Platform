import createNextIntlPlugin from 'next-intl/plugin';

/**
 * Plain ESM on purpose, not TypeScript: `next start` loads this file at **runtime**, and loading a
 * `.ts` config needs the `typescript` package. That is a devDependency, so the production image
 * (built with `pnpm deploy --prod`) does not have it and the container fails to boot (REQUEST #68).
 *
 * @type {import('next').NextConfig}
 */
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
  eslint: {
    // Linting is a repo-level job (`pnpm lint` with the root flat config), not a build step.
    ignoreDuringBuilds: true,
  },
};

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

export default withNextIntl(config);
