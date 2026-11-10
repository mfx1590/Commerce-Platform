/**
 * The response headers that are the same on every request (Phase 6 D4, #731). Plain ESM so that
 * `next.config.mjs` can import it; the Content-Security-Policy is NOT here because it carries a
 * per-request nonce and is set by the middleware (./csp.ts).
 *
 * `headers()` in next.config is evaluated by `next build`, so `production` is the build's
 * NODE_ENV — the image is always built with `next build`, which is production.
 */

/** Two years, the value the HSTS preload list asks for. Not `preload`: that is a domain-wide promise. */
export const HSTS = 'max-age=63072000; includeSubDomains';

/** Deny the powerful features the admin never uses; an empty allow-list means "nobody, not even us". */
export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=()';

/**
 * @param {{ production: boolean }} options
 * @returns {{ key: string, value: string }[]}
 */
export function staticSecurityHeaders({ production }) {
  return [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: PERMISSIONS_POLICY },
    // Only over TLS: a dev server on http://localhost must not teach the browser to refuse it.
    ...(production ? [{ key: 'Strict-Transport-Security', value: HSTS }] : []),
  ];
}
