import type {
  CampaignLandingDocument,
  FooterDocument,
  LegalDocument,
  NavigationDocument,
  PageDocument,
} from '@platform/cms';
import { BRAND_DATASETS, datasetForStore } from '@platform/cms';
import { CmsClient, CmsError, type GroqQuery, type GroqParams } from './client';
import type { CmsConfig } from './config';
import { isCmsConfigured } from './config';
import { queries } from './queries';
import { CMS_REVALIDATE_SECONDS, cmsTags } from './tags';

/**
 * The reads the routes use. Every one of them resolves to content or to "nothing", never to an
 * exception: a missing CMS, an unknown store, a network failure or a 500 from Sanity all render the
 * storefront's static fallback (task 2.3) instead of an error page. Problems are reported with one
 * `console.warn` — once per process for missing configuration, once per failed request otherwise —
 * carrying the status and Sanity's request id, never the query result or a token.
 */

export interface CmsReader {
  /** `true` when this reader serves drafts (preview cookie verified and a read token exists). */
  readonly preview: boolean;
  readonly dataset: string | null;
  page(locale: string, slug: string): Promise<PageDocument | null>;
  campaignLanding(locale: string, slug: string): Promise<CampaignLandingDocument | null>;
  legal(locale: string, slug: string): Promise<LegalDocument | null>;
  navigation(locale: string, key?: 'main' | 'utility'): Promise<NavigationDocument | null>;
  footer(locale: string): Promise<FooterDocument | null>;
  pageSlugs(locale: string): Promise<string[]>;
  legalSlugs(locale: string): Promise<string[]>;
}

export interface ReaderOptions {
  config: CmsConfig;
  /** `store.code` from `GET /store`, or `null` when the store is unknown. */
  storeCode: string | null;
  /** Whether the request carries a valid preview cookie. Drafts still need `readToken`. */
  preview?: boolean | undefined;
  fetchImpl?: typeof fetch | undefined;
  warn?: ((message: string) => void) | undefined;
}

let warnedUnconfigured = false;

/** Tests only. */
export function resetCmsWarnings(): void {
  warnedUnconfigured = false;
}

const empty: CmsReader = {
  preview: false,
  dataset: null,
  page: async () => null,
  campaignLanding: async () => null,
  legal: async () => null,
  navigation: async () => null,
  footer: async () => null,
  pageSlugs: async () => [],
  legalSlugs: async () => [],
};

function warnOnce(warn: (message: string) => void, message: string): void {
  if (warnedUnconfigured) return;
  warnedUnconfigured = true;
  warn(message);
}

export function createReader(options: ReaderOptions): CmsReader {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const { config, storeCode } = options;

  if (!isCmsConfigured(config)) {
    warnOnce(warn, '[cms] SANITY_PROJECT_ID is not set: rendering without CMS content');
    return empty;
  }
  if (storeCode === null) {
    warnOnce(warn, '[cms] store unknown (GET /store failed): rendering without CMS content');
    return empty;
  }
  let dataset: string;
  try {
    dataset = datasetForStore(storeCode);
  } catch {
    warnOnce(
      warn,
      `[cms] no dataset for store "${storeCode}" (known: ${BRAND_DATASETS.map((b) => b.storeCode).join(', ')}): rendering without CMS content`,
    );
    return empty;
  }

  const preview = options.preview === true && config.readToken !== null;
  const client = new CmsClient({
    projectId: config.projectId,
    dataset,
    apiVersion: config.apiVersion,
    readToken: config.readToken,
    preview,
    fetchImpl: options.fetchImpl,
  });

  async function read<T>(
    query: GroqQuery<T>,
    params: GroqParams,
    tags: string[],
    fallback: T,
  ): Promise<T> {
    try {
      const result = await client.fetch(query, params, {
        tags: [cmsTags.all, ...tags],
        revalidate: CMS_REVALIDATE_SECONDS,
      });
      return result ?? fallback;
    } catch (error) {
      const detail =
        error instanceof CmsError
          ? `${error.status}${error.requestId ? ` request ${error.requestId}` : ''}`
          : error instanceof Error
            ? error.message
            : String(error);
      warn(`[cms] ${dataset} ${preview ? 'preview' : 'published'} read failed (${detail})`);
      return fallback;
    }
  }

  const bySlug =
    <T>(type: keyof typeof queries & string, query: GroqQuery<T | null>) =>
    (locale: string, slug: string) =>
      read(
        query,
        { locale, slug },
        [cmsTags.type(type), cmsTags.document(type, locale, slug)],
        null,
      );

  return {
    preview,
    dataset,
    page: bySlug('page', queries.page),
    campaignLanding: bySlug('campaignLanding', queries.campaignLanding),
    legal: bySlug('legal', queries.legal),
    navigation: (locale, key = 'main') =>
      read(
        queries.navigation,
        { locale, key },
        [cmsTags.type('navigation'), cmsTags.document('navigation', locale, key)],
        null,
      ),
    footer: (locale) =>
      read(
        queries.footer,
        { locale },
        [cmsTags.type('footer'), cmsTags.document('footer', locale, 'default')],
        null,
      ),
    pageSlugs: (locale) => read(queries.pageSlugs, { locale }, [cmsTags.type('page')], []),
    legalSlugs: (locale) => read(queries.legalSlugs, { locale }, [cmsTags.type('legal')], []),
  };
}
