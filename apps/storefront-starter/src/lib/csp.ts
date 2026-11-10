/**
 * The storefront's Content-Security-Policy, built per request (#782).
 *
 * **Scripts: a per-request nonce plus `'strict-dynamic'`, with no `'unsafe-inline'` and no
 * `'unsafe-eval'` in production.** The middleware makes a new nonce for every response and puts it
 * on the response's policy and on the forwarded request's. Next reads it back from the request and
 * stamps it on its own inline bootstrap and RSC-payload scripts and its chunk `<script>` tags.
 * `'strict-dynamic'` then trusts what those scripts load: the chunks, and Stripe.js, which
 * `loadStripe()` inserts. Every script the storefront runs is listed, with how it is authorised,
 * in `SCRIPTS.md`.
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
 * Pure, so every directive is unit-tested.
 */

export const CSP_HEADER = 'Content-Security-Policy';
/** Request header the render can read the nonce from. Next itself reads it from `CSP_HEADER`. */
export const NONCE_HEADER = 'x-nonce';

export interface CspInput {
  /** This response's nonce (`newNonce()`). */
  nonce: string;
  /** `KEYCLOAK_URL`: where sign-out's 303 lands, so it must be an allowed form target. */
  keycloakUrl: string | undefined;
  /** Campaign embed origins, already vetted by `parseFrameHosts`. */
  frameHosts: readonly string[];
  /** The request path: only embed routes frame the campaign hosts (`isEmbedRoute`). */
  pathname: string;
  /** `NODE_ENV === 'production'`; development adds what `next dev` needs and nothing else. */
  production: boolean;
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

/** 128 random bits, base64. Web Crypto, so it runs in the middleware's edge runtime. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Stripe's Payment Element (#358): its script, the iframes that hold the card fields and 3-D Secure,
 * and the API the Element calls from the browser. Exactly the hosts Stripe documents for the
 * Payment Element with card payments: no wildcard, nothing wider. Card data goes from those
 * iframes to Stripe; it never reaches this origin.
 */
export const STRIPE_SCRIPT_HOSTS = ['https://js.stripe.com'] as const;
export const STRIPE_FRAME_HOSTS = ['https://js.stripe.com', 'https://hooks.stripe.com'] as const;
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
 * ("Frames"): any site published on these builders can be framed on an embed route.
 *
 * Adding a domain here is a code change with review, never an environment setting. Keep it in step
 * with window 6's `EMBED_HOSTS` (`@platform/cms`).
 */
export const WILDCARD_EMBED_DOMAINS = ['framer.app', 'framer.website', 'builder.io'] as const;

/**
 * The campaign embed list (`CSP_FRAME_HOSTS`, built from window 6's `EMBED_HOSTS`), narrowed to
 * **bare https origins**, plus `https://*.<domain>` for a domain in `WILDCARD_EMBED_DOMAINS`. Any
 * other wildcard, a path, a query, credentials, another scheme or anything unparseable is refused
 * and reported, never passed to the browser: a wildcard would let any subdomain be framed, and a
 * path is not something `frame-src` can enforce the way it reads.
 */
export function parseFrameHosts(raw: string | undefined): {
  hosts: string[];
  refused: FrameHostRefusal[];
} {
  const hosts: string[] = [];
  const refused: FrameHostRefusal[] = [];
  for (const entry of (raw ?? '').split(/\s+/).filter(Boolean)) {
    if (entry.includes('*')) {
      const domain = /^https:\/\/\*\.([a-z0-9.-]+)$/.exec(entry)?.[1];
      if (domain !== undefined && (WILDCARD_EMBED_DOMAINS as readonly string[]).includes(domain)) {
        if (!hosts.includes(entry)) hosts.push(entry);
      } else {
        refused.push({ entry, reason: 'wildcard (not an allowed site-builder domain)' });
      }
      continue;
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      refused.push({ entry, reason: 'not a URL' });
      continue;
    }
    if (url.protocol !== 'https:') {
      refused.push({ entry, reason: 'not https' });
    } else if (url.username !== '' || url.password !== '') {
      refused.push({ entry, reason: 'credentials' });
    } else if (url.origin !== entry.replace(/\/$/, '')) {
      refused.push({ entry, reason: 'not a bare origin (path, query or fragment)' });
    } else if (!hosts.includes(url.origin)) {
      hosts.push(url.origin);
    }
  }
  return { hosts, refused };
}

/**
 * The "embed routes": the only pages whose `frame-src` includes the campaign embed hosts, because
 * they are the only pages that render CMS blocks, and so an embed. Those are home (window 6's home
 * slots, REQUEST #178) and the content routes `campaign/*`, `pages/*` and `legal/*`. Every other
 * page frames ourselves and Stripe only: PLP, PDP, cart, checkout and payment, orders, account,
 * the 404. Strict is the default, so a new route is strict until it is named here.
 *
 * What this does and does NOT guarantee: a policy binds to the document it arrived with. A full
 * load of a strict page (a direct visit, a reload, the return from 3-D Secure) gets the strict
 * `frame-src`. A client-side navigation from an embed route (say, home → a product → the cart)
 * keeps home's `frame-src`. No strict page renders an embed, so what that leaves is an injected
 * frame, which the script policy (the same nonce everywhere, whichever way the customer arrived)
 * is what stops.
 */
export function isEmbedRoute(pathname: string): boolean {
  // The locale segment has no dot, so a file path (`/x.png`) is never mistaken for a home page.
  return /^\/[^/.]+(\/(campaign|pages|legal)(\/.*)?)?\/?$/.test(pathname);
}

export function contentSecurityPolicy({
  nonce,
  keycloakUrl,
  frameHosts,
  pathname,
  production,
}: CspInput): string {
  const frames = isEmbedRoute(pathname) ? frameHosts : [];

  return [
    "default-src 'self'",
    // Only scripts carrying this response's nonce, and what they load ('strict-dynamic'). Stripe's
    // host stays for browsers older than CSP3 (which ignore 'strict-dynamic'). There is no
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
    // Campaign embeds (REQUEST #199) on embed routes only. The sandbox on each iframe is the first
    // layer; this stops an embed being pointed at a host nobody reviewed.
    `frame-src 'self' ${[...STRIPE_FRAME_HOSTS, ...frames].join(' ')}`,
    // Nothing may frame us: clickjacking a checkout is the attack this prevents.
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    // Chrome evaluates form-action against the URL *after* redirects, and sign-out answers 303 to
    // the identity provider: with 'self' alone the SSO session is never ended.
    `form-action 'self' ${keycloakOrigin(keycloakUrl)}`,
    'upgrade-insecure-requests',
  ].join('; ');
}
