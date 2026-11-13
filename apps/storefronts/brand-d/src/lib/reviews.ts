import type { Product } from './store-api';

/**
 * Product reviews on the PDP (task 2.4).
 *
 * **The Store API has no review shape yet.** `grep -c review store-api.yaml` → 0 at
 * contracts-v0.4.4; window 17's reviews are Phase 3 in docs/marketing-scope.md, and the Admin API's
 * moderation paths (0.3.0) have no customer-facing counterpart. So this module defines the shape the
 * storefront needs, reads it from wherever it is available today, and renders nothing when there is
 * nothing — rather than inventing a placeholder rating, which would be a lie in structured data and
 * a lie to a shopper.
 *
 * The shape is the one proposed in the filed `CONTRACT CHANGE`, so when it lands the only change
 * here is deleting `fromProductMetadata` in favour of the typed field.
 */

export interface Review {
  id: string;
  /** 1–5. Anything outside that is dropped rather than clamped: a 7-star review is bad data. */
  rating: number;
  title: string | null;
  body: string | null;
  /** A display name, never an email — see `isPii` in the test. */
  author: string | null;
  /** ISO-8601. */
  created_at: string;
  /** Whether the reviewer's purchase was verified; shoppers weigh this heavily. */
  verified_purchase: boolean;
}

export interface ReviewSummary {
  count: number;
  /** Mean rating, one decimal place, or `null` when there are no reviews. */
  average: number | null;
}

export const MIN_RATING = 1;
export const MAX_RATING = 5;

function isRating(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_RATING &&
    value <= MAX_RATING
  );
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Narrow one untrusted record into a `Review`, or `null`.
 *
 * Reviews are customer-authored text arriving through a CMS or a third party, so every field is
 * checked. A record without a usable rating or id is dropped entirely: a review list that silently
 * renders "undefined stars" is worse than a shorter list.
 */
export function parseReview(value: unknown): Review | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const id = optionalString(raw.id);
  if (id === null || !isRating(raw.rating)) return null;

  return {
    id,
    rating: raw.rating,
    title: optionalString(raw.title),
    body: optionalString(raw.body),
    author: optionalString(raw.author),
    created_at: optionalString(raw.created_at) ?? new Date(0).toISOString(),
    verified_purchase: raw.verified_purchase === true,
  };
}

export function parseReviews(value: unknown): Review[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseReview).filter((review): review is Review => review !== null);
}

/**
 * Today's only source: a `reviews` array on the product's free-form `attributes`. That is how a
 * brand can wire Trustpilot or Judge.me output through the catalogue before the contract has a
 * review shape — and it is why this returns an empty list rather than throwing when nothing is there.
 */
export function fromProductMetadata(product: Product): Review[] {
  return parseReviews((product.attributes as Record<string, unknown> | undefined)?.reviews);
}

/** Newest first — what a shopper wants, and what makes a stale review list obvious. */
export function sortNewestFirst(reviews: Review[]): Review[] {
  return [...reviews].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function summarise(reviews: Review[]): ReviewSummary {
  if (reviews.length === 0) return { count: 0, average: null };
  const total = reviews.reduce((sum, review) => sum + review.rating, 0);
  return { count: reviews.length, average: Math.round((total / reviews.length) * 10) / 10 };
}
