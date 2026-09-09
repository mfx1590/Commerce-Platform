// Required-field rules for the two channels we render (#146).
//
// Sources: Google Merchant Center product data specification (id, title, description, link, image_link,
// availability, price; brand + gtin required for new branded goods) and Meta's commerce catalogue feed spec
// (id, title, description, availability, condition, price, link, image_link, brand). Both are trimmed here to
// the fields our catalogue can actually supply — `condition` is always `new` for a D2C brand and is written by
// the Meta renderer as a constant rather than validated.
//
// The contract for what happens to a bad row (#146: "reported in `errors`, not silently dropped"):
//   * the item keeps its `errors` array and is still returned by `listFeedItems`, so a merchandiser can see
//     exactly which product is wrong and why;
//   * it is NOT written into the published file — Google and Meta reject such rows on ingest anyway, and a feed
//     that is half-rejected at the channel is harder to debug than one that is short by two items;
//   * one `{ code, message, product_id }` per bad item lands on `product_feed.errors`, which is what the admin
//     screen and the `error` status read.
import type { FeedChannel, FeedError, FeedItem } from './feed-types';

/** Channel-neutral field names of `FeedItem` that each channel insists on. */
const REQUIRED: Record<'google_merchant' | 'meta', readonly (keyof FeedItem)[]> = {
  google_merchant: ['id', 'title', 'description', 'link', 'image_link', 'availability', 'price'],
  meta: ['id', 'title', 'description', 'link', 'image_link', 'availability', 'price', 'brand'],
};

/**
 * Google wants a GTIN for branded goods and warns (not rejects) without one. We surface it as an item error
 * because a silent warning in someone else's dashboard is exactly what this module exists to avoid — but it
 * does not keep the row out of the file, so it is tracked separately from the hard requirements.
 */
const GTIN_ADVISORY: Record<string, string> = {
  google_merchant: 'GTIN missing; Google requires it for branded goods',
};

const MESSAGE: Record<string, string> = {
  id: 'item id (sku) is required',
  title: 'title is required',
  description: 'description is required',
  link: 'link is required (the store needs a primary domain)',
  image_link: 'image_link is required (the product has no image)',
  availability: 'availability is required',
  price: 'price is required (no price in the feed currency)',
  brand: 'brand is required (set product.brand_name or mapping.brand)',
};

function missing(item: FeedItem, field: keyof FeedItem): boolean {
  const value = item[field];
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

/**
 * Validates one built item for a channel. Returns the error CODES for `FeedItem.errors` — the codes are
 * `missing_<field>`, matching the `missing_gtin` example in the contract.
 */
export function validateItem(item: FeedItem, channel: FeedChannel): string[] {
  const required = REQUIRED[channel as 'google_merchant' | 'meta'] ?? [];
  const codes = required.filter((f) => missing(item, f)).map((f) => `missing_${String(f)}`);
  if (GTIN_ADVISORY[channel] && missing(item, 'gtin')) codes.push('missing_gtin');
  return codes;
}

/** True when the item must stay out of the published file (a hard requirement is missing, not the GTIN hint). */
export function blocksPublication(codes: readonly string[]): boolean {
  return codes.some((c) => c !== 'missing_gtin');
}

/** The human-readable message behind an item error code, for `product_feed.errors`. */
export function messageFor(code: string, channel: FeedChannel): string {
  if (code === 'missing_gtin') return GTIN_ADVISORY[channel] ?? 'GTIN missing';
  const field = code.startsWith('missing_') ? code.slice('missing_'.length) : code;
  return MESSAGE[field] ?? `${field} is required`;
}

/**
 * Runs `validateItem` over every item, writing the codes onto each item and returning the feed-level errors.
 * Mutates `items` in place: the same array is what `listFeedItems` serves and what the renderer filters.
 */
export function validateItems(items: FeedItem[], channel: FeedChannel): FeedError[] {
  const errors: FeedError[] = [];
  for (const item of items) {
    const codes = validateItem(item, channel);
    item.errors = codes;
    for (const code of codes) {
      errors.push({ code, message: messageFor(code, channel), product_id: item.product_id });
    }
  }
  return errors;
}

/** The items that actually go into the file. */
export function publishableItems(items: readonly FeedItem[]): FeedItem[] {
  return items.filter((i) => !blocksPublication(i.errors));
}
