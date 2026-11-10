/**
 * The storefront's Content-Security-Policy, built per request (#782).
 *
 * **Scripts: a per-request nonce plus `'strict-dynamic'`, with no `'unsafe-inline'` and no
 * `'unsafe-eval'` in production.** The middleware makes a new nonce for every response and puts it
 * on the response's policy and on the forwarded request's. Next stamps it on its own inline
 * bootstrap and RSC-payload scripts and its chunk `<script>` tags. `'strict-dynamic'` then trusts
 * what those scripts load: the chunks, and Stripe.js, which `loadStripe()` inserts. Every script the
 * storefront runs is listed, with how it is authorised, in `SCRIPTS.md`.
 *
 * **Why this costs no caching.** The production build prerenders exactly one page, `/_not-found`.
 * Every `[locale]` document is already rendered per request: `force-dynamic` (home, cart, checkout,
 * account, orders), `searchParams` (PLP, categories) or the currency cookie (PDP). So the nonce
 * changes no route's rendering mode, which is what made it expensive for the admin (#763).
 *
 * **Why per request and not in `next.config.mjs` `headers()`:** those are evaluated once by
 * `next build` and written into the routes manifest, while the images are built **once** and
 * configured per environment at runtime (Helm sets `KEYCLOAK_URL` differently for dev and staging).
 * A build-time policy carried the build machine's identity provider into every environment. And a
 * nonce is only worth anything if it is new on every response.
 *
 * Pure, so every directive is unit-tested, and the full policy string is pinned per zone.
 */

import { isCheckoutZone } from './csp-zone';

export const CSP_HEADER = 'Content-Security-Policy';

export interface CspInput {
  /** This response's nonce (`newNonce()`). */
  nonce: string;
  /** `KEYCLOAK_URL`: where sign-out's 303 lands, so it must be an allowed form target. */
  keycloakUrl: string | undefined;
  /** Campaign embed sources, already vetted by `parseFrameHosts`. */
  frameHosts: readonly string[];
  /** The request path: the checkout zone frames Stripe only (`isCheckoutZone`). */
  pathname: string;
  /** `NODE_ENV === 'production'`; development adds what `next dev` needs and nothing else. */
  production: boolean;
}

const DEFAULT_KEYCLOAK = 'http://localhost:8180';

/**
 * The identity provider's origin, for `form-action`.
 * - **Production:** a missing or malformed `KEYCLOAK_URL` **throws**, as the admin's does since #763.
 *   A silent localhost default would let the browser refuse sign-out's 303, and nothing else would
 *   say so.
 * - **Development:** falls back to the local Keycloak.
 * Never a raw value in the directive: an unparseable CSP is dropped by the browser entirely.
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

/** 128 random bits, base64. Web Crypto, so it runs in the middleware's edge runtime. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Stripe's Payment Element (#358): its script, the iframes that hold the card fields and 3-D Secure,
 * and the API the Element calls from the browser. Exactly the Stripe.js list in Stripe's security
 * guide (docs.stripe.com/security/guide, "Content Security Policy", checked 2026-11-10; the page
 * shows no date):
 * - `*.js.stripe.com` is Stripe's own, to start frames on other origins for performance;
 * - `hooks.stripe.com` is 3-D Secure.
 *
 * Not listed because the storefront uses neither: `maps.googleapis.com` (the Address Element with
 * our own Maps key) and Link's `link.com` hosts. Card data goes from Stripe's iframes to Stripe; it
 * never reaches this origin.
 */
export const STRIPE_SCRIPT_HOSTS = ['https://js.stripe.com', 'https://*.js.stripe.com'] as const;
export const STRIPE_FRAME_HOSTS = [
  'https://js.stripe.com',
  'https://*.js.stripe.com',
  'https://hooks.stripe.com',
] as const;
export const STRIPE_CONNECT_HOSTS = ['https://api.stripe.com'] as const;

export interface FrameHostRefusal {
  entry: string;
  reason: string;
}

/**
 * The only domains a WILDCARD frame host may name (#782, manager's decision): the site builders
 * window 6's Studio embeds from today. Each campaign there is its own subdomain
 * (`<site>.framer.app`), and an editor publishes it from the Studio, so listing exact origins would
 * turn every new campaign into a deploy-time change. The residual is recorded in `SCRIPTS.md`
 * ("Frames"): any site published on these builders can be framed outside the checkout zone.
 *
 * Adding a domain here is a code change with review, never an environment setting. Keep it in step
 * with window 6's `EMBED_HOSTS` (`@platform/cms`, REQUEST #784).
 */
export const WILDCARD_EMBED_DOMAINS = ['framer.app', 'framer.website', 'builder.io'] as const;

/**
 * A frame source this parser emits, and nothing else: `https://`, an optional `*.` (only for a
 * domain in `WILDCARD_EMBED_DOMAINS`), a lower-case host of letters, digits, dots and hyphens, an
 * optional `:port`, an optional trailing slash.
 *
 * The grammar is the security boundary, not `URL`: WHATWG `URL` accepts `;`, `,` and `'` in a host,
 * so `https://a.example;script-src-elem` parses with an origin equal to the entry. Passed through,
 * that token would end `frame-src` and inject a directive of its own (#783 review). The grammar
 * also refuses upper case, IDN (use the `xn--` punycode form), IP literals, credentials, paths and
 * queries.
 */
// The last label (the TLD) starts with a letter, which also rules out an IPv4 literal.
const FRAME_SOURCE = /^https:\/\/(\*\.)?((?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*)(:\d{1,5})?\/?$/;

/**
 * The campaign embed list (`CSP_FRAME_HOSTS`, built from window 6's `EMBED_HOSTS`), narrowed to
 * `FRAME_SOURCE`. Anything else is refused and reported (the middleware logs it once at start),
 * never passed to the browser.
 */
export function parseFrameHosts(raw: string | undefined): {
  hosts: string[];
  refused: FrameHostRefusal[];
} {
  const hosts: string[] = [];
  const refused: FrameHostRefusal[] = [];
  for (const entry of (raw ?? '').split(/\s+/).filter(Boolean)) {
    const match = FRAME_SOURCE.exec(entry);
    if (match === null) {
      refused.push({
        entry,
        reason: entry.includes('*')
          ? 'wildcard (not https://*.<allowed site-builder domain>)'
          : 'not an https origin (lower-case host, optional port, nothing else)',
      });
      continue;
    }
    const [, wildcard, host, port = ''] = match;
    if (wildcard !== undefined && !(WILDCARD_EMBED_DOMAINS as readonly string[]).includes(host!)) {
      refused.push({ entry, reason: 'wildcard (not https://*.<allowed site-builder domain>)' });
      continue;
    }
    const source = `https://${wildcard ?? ''}${host}${port}`;
    if (!hosts.includes(source)) hosts.push(source);
  }
  return { hosts, refused };
}

/**
 * The checkout zone (`src/lib/csp-zone.ts`): the checkout steps and the order confirmation frame
 * Stripe only; everywhere else frames Stripe and the vetted embed hosts. Crossing the boundary is a
 * hard navigation both ways (`ZoneBoundary` in the root layout), so each document carries its own
 * zone's policy; `e2e/csp.spec.ts` asserts it. This replaces the per-route embed scoping withdrawn
 * in the #783 review, which broke embeds after a soft navigation from a strict page.
 */
export { isCheckoutZone };

export function contentSecurityPolicy({
  nonce,
  keycloakUrl,
  frameHosts,
  pathname,
  production,
}: CspInput): string {
  const frames = isCheckoutZone(pathname) ? [] : frameHosts;

  return [
    "default-src 'self'",
    // Only scripts carrying this response's nonce, and what they load ('strict-dynamic'). Stripe's
    // hosts stay for browsers older than CSP3 (which ignore 'strict-dynamic'). There is no
    // 'unsafe-inline' fallback, by decision (#782). `next dev` evaluates modules with eval() for
    // React Refresh, so development alone adds 'unsafe-eval'.
    `script-src 'nonce-${nonce}' 'strict-dynamic' ${STRIPE_SCRIPT_HOSTS.join(' ')}${production ? '' : " 'unsafe-eval'"}`,
    // The CDNs `remotePatterns` allows, plus data:/blob: for inlined placeholders.
    "img-src 'self' data: blob: https://res.cloudinary.com https://images.unsplash.com https://picsum.photos",
    "font-src 'self' data:",
    // Hero loops (#330) are Cloudinary video delivery URLs; nothing else plays media.
    "media-src 'self' https://res.cloudinary.com",
    // Styles stay 'unsafe-inline': React writes style="" attributes and Next its own <style>.
    // Inline style is not script execution; stated, not implied.
    "style-src 'self' 'unsafe-inline'",
    // The Store API is called server-side; the browser talks to this origin and, from the Payment
    // Element, to Stripe's API.
    `connect-src 'self' ${STRIPE_CONNECT_HOSTS.join(' ')}`,
    // Campaign embeds (REQUEST #199) everywhere but the checkout zone. The sandbox on each iframe
    // is the first layer; this stops an embed being pointed at a host nobody reviewed.
    `frame-src 'self' ${[...STRIPE_FRAME_HOSTS, ...frames].join(' ')}`,
    // Nothing may frame us: clickjacking a checkout is the attack this prevents.
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    // Chrome evaluates form-action against the URL *after* redirects, and sign-out answers 303 to
    // the identity provider: with 'self' alone the SSO session is never ended.
    `form-action 'self' ${keycloakOrigin(keycloakUrl, production)}`,
    'upgrade-insecure-requests',
  ].join('; ');
}
