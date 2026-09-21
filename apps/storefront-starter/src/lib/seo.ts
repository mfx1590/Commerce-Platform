import { brandConfig, siteUrl } from '@/brand/config';
import { locales } from '@/i18n/routing';
import type { Product, Variant } from './store-api';

/**
 * SEO as pure functions.
 *
 * Nothing here touches the network, React or `next/headers`, so every rule — which URL is canonical,
 * what a crawler is told about price and availability, how a sitemap is paged — is unit-tested
 * directly instead of being inferred from a rendered page.
 */

// ── URLs ─────────────────────────────────────────────────────────────────────────────────────────

/** An absolute URL for a locale-scoped path. Crawlers reject relative canonicals and `hreflang`. */
export function absoluteUrl(path: string, env?: Record<string, string | undefined>): string {
  const base = siteUrl(env);
  if (path === '' || path === '/') return base;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function localizedPath(locale: string, path = ''): string {
  const suffix = path === '' || path === '/' ? '' : path.startsWith('/') ? path : `/${path}`;
  return `/${locale}${suffix}`;
}

/**
 * `alternates` for a page that exists in every supported locale: a self-referencing canonical plus
 * one `hreflang` per locale, and `x-default` pointing at the default locale so a crawler has
 * somewhere to send a visitor whose language we do not sell in.
 *
 * Paths are returned **relative**; `metadataBase` in the root layout makes them absolute. Next does
 * that join itself, and doing it twice produces `https://sitehttps://site/...`.
 */
export function alternatesFor(
  locale: string,
  path = '',
  { defaultLocale = locales[0] ?? 'en-GB' }: { defaultLocale?: string } = {},
): { canonical: string; languages: Record<string, string> } {
  const languages: Record<string, string> = Object.fromEntries(
    locales.map((l) => [l, localizedPath(l, path)]),
  );
  languages['x-default'] = localizedPath(defaultLocale, path);

  return { canonical: localizedPath(locale, path), languages };
}

/**
 * The canonical for a page the API has an opinion about.
 *
 * `seo.canonical` comes back as a **path** (`/products/classic-tee`) with no locale prefix — the API
 * does not know which locale is being rendered. Using it verbatim produces a canonical pointing at a
 * URL that does not exist: every page lives under `/<locale>/`, so the un-prefixed path only
 * redirects. Lighthouse catches it as "points to another hreflang location"; a crawler simply
 * follows it away from the page it was supposed to identify.
 *
 * So: an **absolute** canonical is authoritative and used as-is (a product syndicated across brands
 * points at its origin), while a **relative** one is a path within this site and is localised.
 */
export function canonicalFor(
  locale: string,
  apiCanonical: string | undefined,
  path: string,
): string {
  if (apiCanonical === undefined || apiCanonical.trim() === '') return localizedPath(locale, path);
  if (/^https?:\/\//i.test(apiCanonical)) return apiCanonical;
  return localizedPath(locale, apiCanonical);
}

// ── JSON-LD ──────────────────────────────────────────────────────────────────────────────────────

/**
 * schema.org availability. A crawler shows "in stock" to a shopper, so this follows the same rule
 * the buy button does rather than a second opinion: backorderable stock is available to order, and
 * `available_quantity: null` means inventory is not managed, not that there is none.
 */
export function availabilityOf(variant: Variant | undefined): string {
  if (variant === undefined) return 'https://schema.org/OutOfStock';
  if (variant.in_stock) return 'https://schema.org/InStock';
  if (variant.allow_backorder) return 'https://schema.org/BackOrder';
  return 'https://schema.org/OutOfStock';
}

/** Minor units are the contract's money representation; schema.org wants a decimal string. */
export function priceString(amountMinor: number, currency: string): string {
  const digits = currency === 'JPY' || currency === 'KRW' ? 0 : 2;
  return (amountMinor / 10 ** digits).toFixed(digits);
}

export interface ProductJsonLd {
  '@context': 'https://schema.org';
  '@type': 'Product';
  name: string;
  [key: string]: unknown;
}

/**
 * `Product` JSON-LD with one `Offer` per variant.
 *
 * Per-variant offers rather than one aggregate: a shopper searching for a specific size should be
 * told whether *that* variant is in stock, and window 17's feeds need the same per-SKU shape.
 *
 * `gtin` is not in the Store API's `Product` schema, so it is read from the free-form `attributes`
 * bag when a brand populates it — no contract change needed, and nothing is emitted when it is
 * absent. An empty or partial field is omitted entirely: Google penalises a declared-but-wrong
 * property harder than a missing one.
 */
export function productJsonLd(
  product: Product,
  { url, locale }: { url: string; locale: string },
): ProductJsonLd {
  const images = product.media
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((item) => item.url);

  const offers = product.variants.map((variant) => ({
    '@type': 'Offer',
    url,
    priceCurrency: variant.price.currency,
    price: priceString(variant.price.amount_minor, variant.price.currency),
    availability: availabilityOf(variant),
    itemCondition: 'https://schema.org/NewCondition',
    ...(variant.sku === '' ? {} : { sku: variant.sku }),
  }));

  const gtin = stringAttribute(product.attributes, 'gtin');
  const description = product.seo?.description ?? product.subtitle ?? product.description;

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.title,
    url,
    inLanguage: locale,
    ...(description === null || description === undefined ? {} : { description }),
    ...(images.length === 0 ? {} : { image: images }),
    ...(product.brand_name === null
      ? {}
      : { brand: { '@type': 'Brand', name: product.brand_name } }),
    ...(gtin === undefined ? {} : { gtin }),
    ...(product.category === null ? {} : { category: product.category.name }),
    ...(offers.length === 0 ? {} : { offers }),
  };
}

function stringAttribute(
  attributes: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const raw = attributes?.[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export interface Crumb {
  name: string;
  /** Relative, locale-scoped path; made absolute here. */
  path: string;
}

/** `BreadcrumbList` matching the breadcrumb the page actually renders — never a fabricated trail. */
export function breadcrumbJsonLd(
  crumbs: Crumb[],
  env?: Record<string, string | undefined>,
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: absoluteUrl(crumb.path, env),
    })),
  };
}

/** The brand itself, for the home page: what a knowledge panel is built from. */
export function organizationJsonLd(
  env?: Record<string, string | undefined>,
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: brandConfig.name,
    url: absoluteUrl('', env),
  };
}

// ── sitemap ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The sitemap protocol's hard limit is 50 000 URLs per file; this is deliberately well under it.
 * Each product contributes one entry per locale, so the page size is counted in **entries**, not in
 * products — a two-locale store with 3 000 products is already 6 000 URLs.
 */
export const SITEMAP_PAGE_SIZE = 5000;

export function sitemapPageCount(entryCount: number): number {
  return Math.max(1, Math.ceil(entryCount / SITEMAP_PAGE_SIZE));
}

/** The page size the Store API allows (`limit` maximum is 100), used when walking the catalogue. */
export const CATALOG_PAGE_SIZE = 100;

/**
 * How many API pages to walk for `total` products, capped so a runaway `total` cannot turn one
 * sitemap request into thousands of upstream calls.
 */
export function catalogPageCount(total: number, maxPages = 100): number {
  return Math.min(maxPages, Math.max(0, Math.ceil(total / CATALOG_PAGE_SIZE)));
}
