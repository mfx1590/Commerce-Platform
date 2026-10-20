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

/**
 * The seeded brands only — throws for anything else. Storefronts do not call this on a route:
 * they resolve the dataset with `resolveDataset`, which never throws (#521).
 */
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

/**
 * Sanity's dataset-name rule: lowercase letters, digits, `_` and `-`, starting with a letter or
 * digit, at most 64 characters. Anything that is not exactly this is not a dataset name — it is
 * never massaged into one.
 */
export const DATASET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
export const DATASET_NAME_MAX_LENGTH = 64;

export function isDatasetName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= DATASET_NAME_MAX_LENGTH &&
    DATASET_NAME_PATTERN.test(value)
  );
}

export interface DatasetSource {
  /** `store.code` from the store row, or `null` when the store is unknown. */
  storeCode: string | null;
  /**
   * `store.content_space_id` from the store row — the dataset name by contract (decision 8), set
   * by the onboarding wizard for a brand that is not in the seed. `null`/absent when unset.
   */
  contentSpaceId?: string | null | undefined;
}

/**
 * The dataset a storefront reads, from the store row and nothing else (#521):
 *
 * 1. `content_space_id`, when it is a valid dataset name;
 * 2. else the seeded list (`BRAND_DATASETS`) by store code;
 * 3. else `null` — the caller renders without CMS content. Never a throw.
 *
 * An invalid `content_space_id` (wrong characters, too long, empty) is treated as unset, not
 * repaired: a dataset name is part of the request URL to Sanity.
 */
export function resolveDataset(source: DatasetSource): string | null {
  if (isDatasetName(source.contentSpaceId)) return source.contentSpaceId;
  if (source.storeCode === null) return null;
  return BRAND_DATASETS.find((b) => b.storeCode === source.storeCode)?.dataset ?? null;
}

/**
 * Extra Studio workspaces from `SANITY_DATASETS` (comma-separated), for brands onboarded from the
 * admin UI that are not in `BRAND_DATASETS`. Optional; every entry must be a dataset name, and the
 * seeded datasets are deduplicated. Throws on an invalid entry — this runs when the Studio starts,
 * never on a storefront route.
 */
export function datasetsFromEnv(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  const seeded = new Set<string>(BRAND_DATASETS.map((b) => b.dataset));
  const extra: string[] = [];
  for (const raw of value.split(',')) {
    const name = raw.trim();
    if (name === '') continue;
    if (!isDatasetName(name)) {
      throw new Error(
        `SANITY_DATASETS entry ${JSON.stringify(name)} is not a dataset name (${DATASET_NAME_PATTERN}, at most ${DATASET_NAME_MAX_LENGTH} characters)`,
      );
    }
    if (!seeded.has(name) && !extra.includes(name)) extra.push(name);
  }
  return extra;
}
