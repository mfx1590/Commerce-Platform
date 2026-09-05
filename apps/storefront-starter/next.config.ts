import type { NextConfig } from 'next';

const config: NextConfig = {
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
