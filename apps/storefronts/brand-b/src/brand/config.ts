/**
 * Brand override mechanism, part 4: static brand identity.
 *
 * **Why this is build configuration and not API data.** The root layout's `generateMetadata` used to
 * await `GET /store` for the title template. That makes it async, and Next then streams the metadata
 * tags into `<body>` instead of `<head>`: React hoists them at hydration so the page is correct in
 * the DOM, but a crawler reading the raw HTML — and Lighthouse — sees no `<meta name="description">`
 * in the head at all. The PLP scored SEO 91 for exactly that reason (task 1.7, measured).
 *
 * Identity does not change per request and does not need an API call, so it lives here. Everything
 * that genuinely is API data — prices, availability, the store's theme, which locales it sells in —
 * keeps coming from the Store API, where it belongs.
 *
 * A brand app edits this file, the same way it edits `tokens.ts`. Nothing here may be secret: it all
 * ships in the HTML.
 */
export interface BrandConfig {
  /** Used in the title template (`%s · <name>`) and as the Open Graph site name. */
  name: string;
  /** The default meta description, for pages that do not set their own. */
  description: string;
  /** Twitter/X handle including the `@`, when the brand has one. */
  twitter?: string;
  /**
   * Overrides the `SITE_URL` environment variable when a brand's canonical origin is fixed at build
   * time. Absolute URLs in metadata, canonicals, the sitemap and JSON-LD all derive from it.
   */
  siteUrl?: string;
}

export const brandConfig: BrandConfig = {
  name: 'Stonecrop',
  description:
    'Hard-wearing everyday clothes, made in small runs in Britain. Free UK returns for 30 days.',
};

/** The site's public origin was needed and nothing says what it is — or what it says is not a URL. */
export class SiteUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteUrlError';
  }
}

/** What `siteUrl()` answers on a developer's machine when nothing is configured. */
export const LOCAL_DEVELOPMENT_SITE_URL = 'http://localhost:3100';

/**
 * This site's public origin — **the one definition of it**, for metadata, canonicals, the sitemap,
 * the OIDC redirect URIs and every redirect a route handler issues (see `src/lib/site-origin.ts`).
 *
 * It is configuration, read when it is needed: `SITE_URL`, set per environment on one promoted
 * image, or `siteUrl` above for a brand whose origin is fixed. It is **never taken from the
 * request**. `Host` and `X-Forwarded-Host` are whatever the client or a misconfigured proxy says
 * they are, and behind the ingress a route handler's own `request.nextUrl.origin` is the pod's
 * internal address (`http://localhost:3100`) whatever the customer typed — which is how sign-out,
 * the sign-in callback and every referral link came to redirect customers to localhost (#298).
 *
 * **Fails closed.** A deployment that does not say where it lives must not guess: the old default
 * of `http://localhost:3100` put that origin into sitemaps, canonicals and redirects of anything
 * started without `SITE_URL`. The default now applies only where it is true —
 *
 * - outside production mode (`next dev`, unit tests), and
 * - while `next build` runs, which has no environment of its own; nothing a build renders may keep
 *   the origin anyway, and `e2e/runtime-origin.spec.ts` holds that —
 *
 * and everywhere else an unset `SITE_URL` throws `SiteUrlError`. That is an **allow-list**, not
 * "anything but production": a pod started with `NODE_ENV=staging`, `test` or nothing at all would
 * otherwise answer `localhost` again — the original defect, from a misspelt variable. Starting a
 * production build by hand therefore needs `SITE_URL` (the e2e and perf scripts set it).
 *
 * Returns the **origin** (`https://shop.example.com`), never the raw value: a `SITE_URL` with a path
 * would otherwise make `siteUrl()` and `siteOrigin()` disagree about where the site is.
 *
 * Trailing slashes are stripped, because every caller joins a path onto this and `//products` is a
 * different URL to a crawler.
 */
export function siteUrl(env: Record<string, string | undefined> = process.env): string {
  const configured = (brandConfig.siteUrl ?? env.SITE_URL ?? '').trim();
  if (configured !== '') return parseSiteUrl(configured);

  const local = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  if (local || env.NEXT_PHASE === 'phase-production-build') return LOCAL_DEVELOPMENT_SITE_URL;
  throw new SiteUrlError(
    'SITE_URL is not set. A production server must be told its public origin ' +
      '(for example SITE_URL=https://shop.example.com): it is used for canonical URLs, the ' +
      'sitemap, the OIDC redirect URIs and every redirect, and it is never read from the request.',
  );
}

function parseSiteUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SiteUrlError(`SITE_URL must be an absolute URL, got "${value}".`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SiteUrlError(`SITE_URL must be an http(s) URL, got "${value}".`);
  }
  return url.origin;
}
