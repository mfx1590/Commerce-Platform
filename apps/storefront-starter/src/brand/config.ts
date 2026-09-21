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
  name: 'Storefront',
  description: 'Shop the full range.',
};

/**
 * The canonical origin. `SITE_URL` wins over the built-in default so one image can serve staging and
 * production; a brand that knows its origin at build time sets `siteUrl` above.
 *
 * Trailing slashes are stripped, because every caller joins a path onto this and `//products` is a
 * different URL to a crawler.
 */
export function siteUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = brandConfig.siteUrl ?? env.SITE_URL ?? 'http://localhost:3100';
  return raw.replace(/\/+$/, '');
}
