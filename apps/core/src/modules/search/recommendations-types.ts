// Recommendations (task P5.8, #607): the thresholds and the pure maths, with no I/O at all, so the lift rule is
// unit-testable from a hand-made basket set without ClickHouse, Postgres or a server.
//
// Two kinds, exactly as migration 0204 stores them:
//   * `bought_together` — co-occurrence per store with LIFT above `minLift` and at least `minSupportBaskets`
//     baskets containing both products. `window_days = 0`, anchored on `product_id`.
//   * `popular` — units sold over the last 7 or 30 days. Store-wide, so `product_id IS NULL`.
//
// Why lift and not raw co-occurrence: a store's best seller co-occurs with everything, so raw counts recommend
// the same few products on every page. Lift divides the observed co-occurrence by what independence would
// predict, which answers "does buying A make B more likely than usual" instead of "is B popular".
//
//   lift(a, b) = P(a and b) / (P(a) * P(b)) = baskets(a, b) * N / (baskets(a) * baskets(b))
//
// Why a minimum support as well: lift is loudest exactly where the evidence is thinnest. Two products bought
// together in the only two baskets that contain either of them have an enormous lift and mean nothing, so a pair
// must also appear in at least `minSupportBaskets` baskets before it can be recommended.
//
// WORKED EXAMPLE (the same numbers as the README and the tests). Lookback window, one store, N = 10 baskets:
//   tee in 6 baskets, cap in 5, both together in 4; mug in 2 baskets, scarf in 2, both together in 2.
//   * tee+cap: support 4 baskets >= 3, lift = 4 * 10 / (6 * 5) = 40 / 30 = 1.333... >= 1.2  -> KEPT, score 1.3333
//   * mug+scarf: lift = 2 * 10 / (2 * 2) = 5.0, the highest in the store, but support 2 < 3 -> DROPPED.
//   The pair is stored in BOTH directions (tee -> cap and cap -> tee): lift is symmetric, but each anchor needs
//   its own list to read.

/** The two `kind` values of `product_recommendation`. */
export type RecommendationKind = 'bought_together' | 'popular';

/** The two popular windows the contract allows (`window_days`). */
export type PopularWindow = 7 | 30;
export const POPULAR_WINDOWS: readonly PopularWindow[] = [7, 30];

/** `window_days` for a co-occurrence row: not windowed, and the CHECK in 0204 insists on 0. */
export const PAIR_WINDOW_DAYS = 0;

/** How many decimals of the lift reach the `score` column (determinism in tests and in the rail's ordering). */
export const SCORE_DECIMALS = 4;

export interface Thresholds {
  /** How far back the baskets are taken from (days before `now`). */
  lookbackDays: number;
  /** A pair needs at least this many baskets containing both products. */
  minSupportBaskets: number;
  /** A pair needs at least this lift. 1.0 = "no more likely than chance", so this is always > 1. */
  minLift: number;
  /** At most this many related products are stored per anchor. */
  maxPairsPerProduct: number;
  /** At most this many products are stored in a store's popular list, per window. */
  maxPopularPerStore: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  lookbackDays: 90,
  minSupportBaskets: 3,
  minLift: 1.2,
  maxPairsPerProduct: 24,
  maxPopularPerStore: 24,
};

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${name} must be a positive integer (got ${raw})`);
  return n;
}

/**
 * Thresholds from the environment, defaults above. The contract's `limit` is capped at 24, so the two `max*`
 * values default to 24 — storing more would never be read.
 */
export function thresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): Thresholds {
  const minLiftRaw = env.CORE_RECOMMENDATIONS_MIN_LIFT;
  let minLift = DEFAULT_THRESHOLDS.minLift;
  if (minLiftRaw !== undefined && minLiftRaw.trim() !== '') {
    const n = Number(minLiftRaw);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(
        `CORE_RECOMMENDATIONS_MIN_LIFT must be a positive number (got ${minLiftRaw})`,
      );
    }
    minLift = n;
  }
  return {
    lookbackDays: positiveInt(
      env.CORE_RECOMMENDATIONS_LOOKBACK_DAYS,
      DEFAULT_THRESHOLDS.lookbackDays,
      'CORE_RECOMMENDATIONS_LOOKBACK_DAYS',
    ),
    minSupportBaskets: positiveInt(
      env.CORE_RECOMMENDATIONS_MIN_SUPPORT,
      DEFAULT_THRESHOLDS.minSupportBaskets,
      'CORE_RECOMMENDATIONS_MIN_SUPPORT',
    ),
    minLift,
    maxPairsPerProduct: positiveInt(
      env.CORE_RECOMMENDATIONS_MAX_PAIRS,
      DEFAULT_THRESHOLDS.maxPairsPerProduct,
      'CORE_RECOMMENDATIONS_MAX_PAIRS',
    ),
    maxPopularPerStore: positiveInt(
      env.CORE_RECOMMENDATIONS_MAX_POPULAR,
      DEFAULT_THRESHOLDS.maxPopularPerStore,
      'CORE_RECOMMENDATIONS_MAX_POPULAR',
    ),
  };
}

/**
 * The compact per-store input both basket sources produce: how many baskets there were, how many contained each
 * product, and how many contained each unordered pair. Nothing else is needed for lift, which is why the
 * ClickHouse side aggregates and only these counts cross the wire (the read-only profile caps result rows).
 */
export interface BasketCounts {
  /** N — distinct orders in the window, after the cancelled and unmapped lines are dropped. */
  basketCount: number;
  /** product id -> number of baskets containing it. */
  singles: Map<string, number>;
  /** `pairKey(a, b)` -> number of baskets containing both. Keys are unordered (a < b). */
  pairs: Map<string, number>;
}

/** The unordered pair key, so (a, b) and (b, a) are one entry. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Splits a `pairKey` back into its two product ids. */
export function splitPairKey(key: string): [string, string] {
  const i = key.indexOf('|');
  return [key.slice(0, i), key.slice(i + 1)];
}

export function emptyCounts(): BasketCounts {
  return { basketCount: 0, singles: new Map(), pairs: new Map() };
}

/**
 * Counts baskets, products and pairs from baskets given as product-id lists. A product appearing twice in one
 * basket (two line items of one order) counts ONCE: a basket is a set, so quantity never inflates support.
 * Used by the fixture basket source and by the tests; the ClickHouse source builds the same counts with SQL.
 */
export function countsFromBaskets(baskets: readonly (readonly string[])[]): BasketCounts {
  const counts = emptyCounts();
  for (const basket of baskets) {
    const distinct = [...new Set(basket)].sort();
    if (distinct.length === 0) continue;
    counts.basketCount += 1;
    for (const p of distinct) counts.singles.set(p, (counts.singles.get(p) ?? 0) + 1);
    for (let i = 0; i < distinct.length; i++) {
      for (let j = i + 1; j < distinct.length; j++) {
        const k = pairKey(distinct[i] as string, distinct[j] as string);
        counts.pairs.set(k, (counts.pairs.get(k) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/** lift(a, b) = baskets(a, b) * N / (baskets(a) * baskets(b)); 0 when either product never appears. */
export function liftOf(counts: BasketCounts, a: string, b: string): number {
  const both = counts.pairs.get(pairKey(a, b)) ?? 0;
  const ca = counts.singles.get(a) ?? 0;
  const cb = counts.singles.get(b) ?? 0;
  if (both === 0 || ca === 0 || cb === 0 || counts.basketCount === 0) return 0;
  return (both * counts.basketCount) / (ca * cb);
}

export function roundScore(n: number): number {
  const f = 10 ** SCORE_DECIMALS;
  return Math.round(n * f) / f;
}

/** One `bought_together` row: the anchor, the related product and the lift that earned it. */
export interface PairRecommendation {
  productId: string;
  relatedProductId: string;
  score: number;
}

/**
 * Every pair above both thresholds, in both directions, capped per anchor. Ordered by score desc, then by the
 * supporting basket count desc, then by product id — so a re-run on unchanged data writes identical rows.
 */
export function recommendPairs(counts: BasketCounts, t: Thresholds): PairRecommendation[] {
  const byAnchor = new Map<
    string,
    { relatedProductId: string; score: number; support: number }[]
  >();
  for (const [key, support] of counts.pairs) {
    if (support < t.minSupportBaskets) continue;
    const [a, b] = splitPairKey(key);
    const score = roundScore(liftOf(counts, a, b));
    if (score < t.minLift) continue;
    for (const [anchor, related] of [
      [a, b],
      [b, a],
    ] as const) {
      const list = byAnchor.get(anchor) ?? [];
      list.push({ relatedProductId: related, score, support });
      byAnchor.set(anchor, list);
    }
  }
  const out: PairRecommendation[] = [];
  for (const anchor of [...byAnchor.keys()].sort()) {
    const list = (byAnchor.get(anchor) ?? []).sort(
      (x, y) =>
        y.score - x.score ||
        y.support - x.support ||
        (x.relatedProductId < y.relatedProductId
          ? -1
          : x.relatedProductId > y.relatedProductId
            ? 1
            : 0),
    );
    for (const r of list.slice(0, t.maxPairsPerProduct)) {
      out.push({ productId: anchor, relatedProductId: r.relatedProductId, score: r.score });
    }
  }
  return out;
}

/** One `popular` row: the product and the units sold in the window. */
export interface PopularRecommendation {
  relatedProductId: string;
  score: number;
}

/** The store's best sellers by units, capped. Ties break on product id so a re-run is identical. */
export function recommendPopular(
  units: ReadonlyMap<string, number>,
  limit: number,
): PopularRecommendation[] {
  return [...units.entries()]
    .filter(([, u]) => u > 0)
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .slice(0, limit)
    .map(([relatedProductId, score]) => ({ relatedProductId, score }));
}
