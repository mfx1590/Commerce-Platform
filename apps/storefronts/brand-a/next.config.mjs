import createNextIntlPlugin from 'next-intl/plugin';

/**
 * Brand A's identity lives here as *runtime defaults*, not source edits: `next build`, `next dev`
 * and `next start` all load this file before any app code runs, so setting the variables with
 * `??=` gives every `process.env` read below the brand's values while the environment still wins.
 * Keeping `src/**` byte-identical to the starter (except `src/brand/**`) is what makes
 * `scripts/sync-from-starter.mjs` re-syncs reviewable (ADR 0004).
 *
 * The publishable key is brand A's seeded dev key (packages/db `SEED_IDS.publishableKeys.brandA`,
 * hashed in the database) — it is public by design and carries no entropy; production deployments
 * set `STORE_PUBLISHABLE_KEY` in the environment. The Store API resolves the store (`brand-a`) and
 * sales channel from the key, so no store code appears in this app.
 */
process.env.SITE_URL ??= 'http://localhost:3101';
process.env.STORE_PUBLISHABLE_KEY ??= 'pk_brand-a_dev_00000000000000000000';

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
    // Product media in the mock (and in Phase 2) comes from the CDN, not from the app.
    remotePatterns: [
      { protocol: 'https', hostname: 'res.cloudinary.com' },
      { protocol: 'https', hostname: 'images.unsplash.com' },
    ],
  },
  eslint: {
    // Linting is a repo-level job (`pnpm lint` with the root flat config), not a build step.
    ignoreDuringBuilds: true,
  },
};

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

export default withNextIntl(config);
