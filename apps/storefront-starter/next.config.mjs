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

export default config;
