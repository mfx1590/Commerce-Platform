/**
 * One Sanity dataset per brand. The dataset name IS the store code (`store.code`), which the core
 * stores as `store.content_space_id` (docs/domain.md, decision 8). `packages/db` seeds these three
 * stores; `test/datasets.test.ts` fails if the two lists drift apart.
 */

export interface BrandDataset {
  /** `store.code` in the core */
  storeCode: string;
  /** Sanity dataset name — identical to the store code by contract */
  dataset: string;
  title: string;
  /** BCP-47 locales the store sells in (`store_locale`); content exists per locale */
  locales: readonly string[];
  defaultLocale: string;
}

export const BRAND_DATASETS = [
  {
    storeCode: 'brand-a',
    dataset: 'brand-a',
    title: 'Brand A',
    locales: ['en-GB', 'de-DE'],
    defaultLocale: 'en-GB',
  },
  {
    storeCode: 'brand-b',
    dataset: 'brand-b',
    title: 'Brand B',
    locales: ['en-GB'],
    defaultLocale: 'en-GB',
  },
  {
    storeCode: 'brand-c',
    dataset: 'brand-c',
    title: 'Brand C',
    locales: ['en-US'],
    defaultLocale: 'en-US',
  },
] as const satisfies readonly BrandDataset[];

export type StoreCode = (typeof BRAND_DATASETS)[number]['storeCode'];
export type Locale = (typeof BRAND_DATASETS)[number]['locales'][number];

/** Every locale any brand publishes in — the pick list on the `locale` field. */
export const ALL_LOCALES: readonly Locale[] = [
  ...new Set(BRAND_DATASETS.flatMap((brand) => brand.locales)),
];

/** `xx-YY` — the shape the storefront's `[locale]` segment and `SUPPORTED_LOCALES` use. */
export const LOCALE_PATTERN = /^[a-z]{2}-[A-Z]{2}$/;

/** Pinned so every query and the Studio speak the same API version. */
export const SANITY_API_VERSION = '2025-02-19';

export function datasetForStore(storeCode: string): string {
  const brand = BRAND_DATASETS.find((b) => b.storeCode === storeCode);
  if (!brand) {
    throw new Error(
      `No CMS dataset for store "${storeCode}" (known: ${BRAND_DATASETS.map((b) => b.storeCode).join(', ')})`,
    );
  }
  return brand.dataset;
}

export function isBrandDataset(dataset: string): dataset is StoreCode {
  return BRAND_DATASETS.some((b) => b.dataset === dataset);
}
