/**
 * The storefront's Content-Security-Policy, built per request.
 *
 * **Why per request and not in `next.config.mjs` `headers()`:** those are evaluated once by
 * `next build` and written into the routes manifest, while the images are built **once** and
 * configured per environment at runtime (Helm sets `KEYCLOAK_URL` differently for dev and staging).
 * A build-time policy therefore carried the build machine's identity provider into every
 * environment, and `form-action` blocked sign-out everywhere it was deployed — silently, in the
 * browser only. The middleware runs per request with the deployment's own environment, so the
 * policy is built there, from this function.
 *
 * Pure, so every directive is unit-tested.
 */

export interface CspInput {
  /** `KEYCLOAK_URL` — where sign-out's 303 lands, so it must be an allowed form target. */
  keycloakUrl: string | undefined;
  /** Space-separated `https://…` hosts campaign embeds may be framed from (window 6's list). */
  frameHosts: string | undefined;
}

const DEFAULT_KEYCLOAK = 'http://localhost:8180';

/**
 * The identity provider's origin. A malformed value falls back to the local default rather than
 * producing a broken directive: an unparseable CSP is dropped by the browser **entirely**, which
 * would silently remove every other protection along with it.
 */
export function keycloakOrigin(url: string | undefined): string {
  try {
    return new URL(url ?? DEFAULT_KEYCLOAK).origin;
  } catch {
    return DEFAULT_KEYCLOAK;
  }
}

/**
 * Stripe's Payment Element (#358): its script, the iframes that hold the card fields and 3-D Secure,
 * and the API the Element calls from the browser. Exactly the hosts Stripe documents for the
 * Payment Element with card payments — no wildcard, nothing wider. Card data goes from those
 * iframes to Stripe; it never reaches this origin.
 */
export const STRIPE_SCRIPT_HOSTS = ['https://js.stripe.com'] as const;
export const STRIPE_FRAME_HOSTS = ['https://js.stripe.com', 'https://hooks.stripe.com'] as const;
export const STRIPE_CONNECT_HOSTS = ['https://api.stripe.com'] as const;

export function contentSecurityPolicy({ keycloakUrl, frameHosts }: CspInput): string {
  const frames = (frameHosts ?? '').split(/\s+/).filter((host) => /^https:\/\/\S+$/.test(host));

  return [
    "default-src 'self'",
    // The CDNs `remotePatterns` allows, plus data:/blob: for inlined placeholders.
    "img-src 'self' data: blob: https://res.cloudinary.com https://images.unsplash.com https://picsum.photos",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    // Not XSS protection: Next's App Router emits inline bootstrap scripts, and removing
    // 'unsafe-inline' needs a nonce threaded through every <Script>. Stated, not implied.
    `script-src 'self' 'unsafe-inline' ${STRIPE_SCRIPT_HOSTS.join(' ')}`,
    // The Store API is called server-side; the browser talks to this origin — and, from the
    // Payment Element, to Stripe's API.
    `connect-src 'self' ${STRIPE_CONNECT_HOSTS.join(' ')}`,
    // Campaign embeds (REQUEST #199). The sandbox on each iframe is the first layer; this stops an
    // embed being pointed at a host nobody reviewed.
    `frame-src 'self' ${[...STRIPE_FRAME_HOSTS, ...frames].join(' ')}`,
    // Nothing may frame us: clickjacking a checkout is the attack this prevents.
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    // Chrome evaluates form-action against the URL *after* redirects, and sign-out answers 303 to
    // the identity provider — with 'self' alone the SSO session is never ended.
    `form-action 'self' ${keycloakOrigin(keycloakUrl)}`,
    'upgrade-insecure-requests',
  ].join('; ');
}
