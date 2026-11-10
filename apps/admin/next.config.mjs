/**
 * Next.js configuration for @platform/admin.
 *
 * `transpilePackages` lets the app import workspace packages (`@platform/contracts`) that ship
 * ESM built by tsc. Nothing here may reference secrets: the OIDC client id is public, everything
 * else is read from the environment at request time on the server only (src/lib/env.ts).
 *
 * Security headers (Phase 6 D4): the static ones are set here for every path, `_next/static`
 * included; the Content-Security-Policy carries a per-request nonce and is set by the middleware
 * (src/lib/security/csp.ts). Both are pinned in test/security-headers.test.ts.
 */

import { staticSecurityHeaders } from './src/lib/security/static-headers.mjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // No `X-Powered-By: Next.js`: it tells a scanner which advisories to try.
  poweredByHeader: false,
  transpilePackages: ['@platform/contracts'],
  // `experimental.typedRoutes` is deliberately off: almost every link in this app is built from a
  // store id at runtime (`/${storeId}/catalog`), which typed routes cannot check, so it would only
  // add casts. Route correctness is covered by the navigation unit tests instead.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: staticSecurityHeaders({ production: process.env.NODE_ENV === 'production' }),
      },
    ];
  },
};

export default nextConfig;
