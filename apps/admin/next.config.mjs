/**
 * Next.js configuration for @platform/admin.
 *
 * `transpilePackages` lets the app import workspace packages (`@platform/contracts`) that ship
 * ESM built by tsc. Nothing here may reference secrets: the OIDC client id is public, everything
 * else is read from the environment at request time on the server only (src/lib/env.ts).
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@platform/contracts'],
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
