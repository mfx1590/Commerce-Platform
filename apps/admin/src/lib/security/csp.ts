/**
 * The admin's Content-Security-Policy, built per request by the middleware (Phase 6 D4, #731).
 *
 * **Why per request and not in `next.config.mjs` `headers()`:** the script policy is nonce-based,
 * and a nonce is only worth anything if it is new on every response. Next reads the nonce back from
 * the request's `Content-Security-Policy` header and stamps it on its own inline bootstrap scripts,
 * which is why the root layout opts every page into dynamic rendering. The same reasoning as the
 * storefront's policy (apps/storefront-starter/src/lib/csp.ts): the identity provider's origin is
 * the deployment's, read at runtime, not the build machine's.
 *
 * Everything the admin's browser talks to is this origin: the Admin API, the BI endpoints and the
 * AI copy drafts are all called server-side (tokens never reach the browser), so `connect-src` is
 * `'self'` only — not even the core's origin.
 *
 * Pure, so every directive is unit-tested.
 */

export const CSP_HEADER = 'Content-Security-Policy';
/** Request header the server components can read the nonce from (`headers().get(NONCE_HEADER)`). */
export const NONCE_HEADER = 'x-nonce';

export interface CspInput {
  /** This response's nonce (`newNonce()`). */
  nonce: string;
  /**
   * `KEYCLOAK_URL` as the environment has it (not env.ts's defaulted value) — Sign out POSTs to us
   * and is answered 303 to it, so it is a form target. Required in production.
   */
  keycloakUrl: string | undefined;
  /** `NODE_ENV === 'production'`; development adds what `next dev` needs and nothing else. */
  production: boolean;
}

const DEFAULT_KEYCLOAK = 'http://localhost:8180';

/**
 * The identity provider's origin. In production a missing or malformed `KEYCLOAK_URL` throws: a
 * silent localhost default would let Sign out's 303 be refused in the browser, and nothing else would
 * say so. In development it falls back to the local Keycloak. Never a raw value in the directive: an
 * unparseable CSP is dropped by the browser **entirely**.
 */
export function keycloakOrigin(url: string | undefined, production = false): string {
  try {
    if (url === undefined || url === '') throw new Error('unset');
    return new URL(url).origin;
  } catch {
    if (production) {
      throw new Error(
        'KEYCLOAK_URL must be set to the identity provider (an absolute http(s) URL) in production: the CSP form-action needs its origin.',
      );
    }
    return DEFAULT_KEYCLOAK;
  }
}

/** 128 random bits, base64 — Web Crypto, so it runs in the middleware's edge runtime. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

export function contentSecurityPolicy({ nonce, keycloakUrl, production }: CspInput): string {
  return [
    "default-src 'self'",
    // No 'unsafe-inline' and no host list: only scripts carrying this response's nonce, and what
    // they load ('strict-dynamic' — Next's chunks). `next dev` evaluates modules with eval() for
    // React Refresh, so development alone adds 'unsafe-eval'.
    `script-src 'nonce-${nonce}' 'strict-dynamic'${production ? '' : " 'unsafe-eval'"}`,
    // Styles stay 'unsafe-inline': React writes style="" attributes (chart legends, the rail).
    // Inline style is not script execution; stated, not implied.
    "style-src 'self' 'unsafe-inline'",
    // The rail's head is /medusa-face.jpg; data:/blob: for canvas and inlined SVG.
    "img-src 'self' data: blob:",
    // next/font/local serves the fonts from /_next/static/media.
    "font-src 'self'",
    "connect-src 'self'",
    // The admin frames nothing, and nothing may frame the admin (clickjacking a refund button).
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    // Chrome checks form-action against the URL *after* redirects, and Sign out answers 303 to the
    // identity provider: with 'self' alone the SSO session is never ended.
    `form-action 'self' ${keycloakOrigin(keycloakUrl, production)}`,
    // Production is served over TLS: any stray http:// subresource is fetched over https instead.
    // Browsers leave http://localhost alone, so the local production e2e is unaffected; `next dev`
    // does without it.
    ...(production ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}
