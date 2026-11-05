import {
  isNotFound,
  storeApi,
  type ProductSummary,
  type RecommendationKind,
  type StoreApiClient,
} from './store-api';

/**
 * Recommendation reads for the two rails (#609, Store API `listProductRecommendations`).
 *
 * A rail is decoration: the page must render the same whether the call is fast, slow, failed or
 * empty. So `loadRecommendations` NEVER throws and never waits longer than its deadline — every
 * failure is an empty rail, and an empty rail renders nothing. The deadline aborts the request as
 * well as giving up on it, so a stalled core does not keep a socket per page view.
 */

/** The surfaces a rail appears on; also the `surface` property of the analytics events. */
export type RecommendationSurface = 'pdp' | 'cart';

export type RecommendationAnchor =
  { surface: 'pdp'; productId: string } | { surface: 'cart'; variantIds: string[] };

export interface Recommendations {
  /** The kind SERVED (the response's `kind`), or `null` when nothing was served. */
  kind: RecommendationKind | null;
  items: ProductSummary[];
}

export const EMPTY_RECOMMENDATIONS: Recommendations = { kind: null, items: [] };

/** Contract maximum for `variant_ids`. */
export const MAX_VARIANT_IDS = 100;
/** One row of cards on a desktop and two on a phone. */
export const RAIL_LIMIT = 4;
/** How long a page will wait for its rail before rendering without one. */
export const DEFAULT_TIMEOUT_MS = 300;

/** PDP rails are the same for every shopper; a minute of staleness matches the catalogue reads. */
const PDP_REVALIDATE = 60;

/** `RECOMMENDATIONS_TIMEOUT_MS`, a positive integer; anything else is the default. */
export function recommendationsTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.RECOMMENDATIONS_TIMEOUT_MS?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

export interface LoadOptions {
  currency?: string | undefined;
  timeoutMs?: number;
  client?: Pick<StoreApiClient, 'listProductRecommendations'>;
}

export async function loadRecommendations(
  anchor: RecommendationAnchor,
  { currency, timeoutMs = recommendationsTimeoutMs(), client = storeApi() }: LoadOptions = {},
): Promise<Recommendations> {
  const variantIds =
    anchor.surface === 'cart' ? [...new Set(anchor.variantIds)].slice(0, MAX_VARIANT_IDS) : [];
  if (anchor.surface === 'cart' && variantIds.length === 0) return EMPTY_RECOMMENDATIONS;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Recommendations>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(EMPTY_RECOMMENDATIONS);
    }, timeoutMs);
  });

  const request = client
    .listProductRecommendations(
      {
        kind: 'bought_together',
        limit: RAIL_LIMIT,
        ...(anchor.surface === 'pdp'
          ? { product_id: anchor.productId }
          : { variant_ids: variantIds }),
        ...(currency === undefined ? {} : { currency }),
      },
      anchor.surface === 'pdp'
        ? { signal: controller.signal, revalidate: PDP_REVALIDATE, tags: ['recommendations'] }
        : { signal: controller.signal, cache: 'no-store' },
    )
    .then(
      // No anchor filter: the core never recommends an anchor back to itself (#609). The mock's
      // single example can, and that is what keeps a populated rail visible against it.
      (list): Recommendations => ({ kind: list.kind, items: list.items.slice(0, RAIL_LIMIT) }),
      (error: unknown): Recommendations => {
        // A 404 means the anchor ids are not a published product of this store: a bug worth a
        // note in development, a silent empty rail for a shopper. Ids only — nothing personal.
        if (isNotFound(error) && process.env.NODE_ENV !== 'production') {
          console.warn(`[recommendations] 404 for the ${anchor.surface} anchor`);
        }
        return EMPTY_RECOMMENDATIONS;
      },
    );

  try {
    return await Promise.race([request, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
