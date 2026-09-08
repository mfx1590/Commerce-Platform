// Attribution at order placement (Integration 1, docs/marketing-scope.md). The storefront captures UTM/referrer
// touches into `cart.metadata.attribution = { first, last, captured_at }` (apps/storefront-starter/src/lib/attribution.ts).
// At placement the checkout module (window 1, task 2.2) calls `recordAttribution` inside the placement
// transaction: it copies the cart metadata onto the order, writes one `attribution` row per touch and emits one
// `attribution.recorded` v1 event per row through the outbox. Unknown or malformed metadata never fails a
// placement — attribution is best effort and yields no rows.
import type { Queryable } from '@platform/db';
import type { EventEnvelope } from '@platform/events';
import { buildEvent, eventActor, withEvents } from '../outbox';
import type { Actor } from './audit';

export type Touch = 'first' | 'last';

export interface AttributionTouch {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  /** Origin only (scheme + host); a full referrer URL is reduced here even if the client sent one. */
  referrer: string | null;
  landing_path: string | null;
  /** When the storefront captured the touch (ISO-8601); falls back to `captured_at`, then to `now`. */
  captured_at: string | null;
}

export interface ParsedAttribution {
  first: AttributionTouch | null;
  last: AttributionTouch | null;
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
/** Same ceiling as the storefront cookie: a database column is not a log either. */
const MAX_VALUE_LENGTH = 200;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, MAX_VALUE_LENGTH);
}

function timestamp(value: unknown): string | null {
  const s = text(value);
  if (s === null) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Referrer reduced to its origin; anything that does not parse as an absolute URL is dropped. */
export function referrerOrigin(value: unknown): string | null {
  const s = text(value);
  if (s === null) return null;
  try {
    const url = new URL(s);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function touch(raw: unknown, fallbackCapturedAt: string | null): AttributionTouch | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const t: AttributionTouch = {
    utm_source: text(r.utm_source),
    utm_medium: text(r.utm_medium),
    utm_campaign: text(r.utm_campaign),
    utm_term: text(r.utm_term),
    utm_content: text(r.utm_content),
    referrer: referrerOrigin(r.referrer),
    landing_path: text(r.landing_path),
    captured_at: timestamp(r.at) ?? timestamp(r.captured_at) ?? fallbackCapturedAt,
  };
  const empty =
    UTM_KEYS.every((k) => t[k] === null) && t.referrer === null && t.landing_path === null;
  return empty ? null : t;
}

/**
 * Reads `metadata.attribution` from a cart's metadata. Tolerant by design: a missing or malformed block yields
 * `{ first: null, last: null }`; values are trimmed and capped; the referrer is reduced to its origin.
 */
export function parseCartAttribution(cartMetadata: unknown): ParsedAttribution {
  if (cartMetadata === null || typeof cartMetadata !== 'object' || Array.isArray(cartMetadata)) {
    return { first: null, last: null };
  }
  const block = (cartMetadata as Record<string, unknown>).attribution;
  if (block === null || typeof block !== 'object' || Array.isArray(block))
    return { first: null, last: null };
  const b = block as Record<string, unknown>;
  const capturedAt = timestamp(b.captured_at);
  return { first: touch(b.first, capturedAt), last: touch(b.last, capturedAt) };
}

/**
 * The order's metadata at placement: a plain JSON copy of the cart's (the Store API contract says
 * `order.metadata` is "copied from cart.metadata when the order is placed"). Non-object metadata becomes `{}`.
 */
export function orderMetadataFromCart(cartMetadata: unknown): Record<string, unknown> {
  if (cartMetadata === null || typeof cartMetadata !== 'object' || Array.isArray(cartMetadata))
    return {};
  return JSON.parse(JSON.stringify(cartMetadata)) as Record<string, unknown>;
}

export interface RecordAttributionInput {
  organizationId: string;
  storeId: string;
  orderId: string;
  cartId: string | null;
  cartMetadata: unknown;
  actor?: Actor;
  /** Injectable clock for tests. */
  now?: Date;
}

export interface AttributionRow {
  id: string;
  touch: Touch;
  captured_at: string;
}

/**
 * Inserts one `attribution` row per touch present in the cart metadata and emits `attribution.recorded` for each,
 * on the caller's transaction (the placement transaction). Returns the rows written (possibly none).
 * `campaign_id` stays NULL here: linking a touch to a campaign happens at report time (window 17).
 */
export async function recordAttribution(
  tx: Queryable,
  input: RecordAttributionInput,
): Promise<AttributionRow[]> {
  const parsed = parseCartAttribution(input.cartMetadata);
  const now = input.now ?? new Date();
  const rows: AttributionRow[] = [];
  const events: EventEnvelope[] = [];
  for (const t of ['first', 'last'] as const) {
    const touchData = parsed[t];
    if (!touchData) continue;
    const capturedAt = touchData.captured_at ?? now.toISOString();
    const res = await tx.query<{ id: string; captured_at: Date }>(
      `INSERT INTO attribution (organization_id, store_id, order_id, cart_id, touch,
         utm_source, utm_medium, utm_campaign, utm_term, utm_content, referrer, landing_path, captured_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id, captured_at`,
      [
        input.organizationId,
        input.storeId,
        input.orderId,
        input.cartId,
        t,
        touchData.utm_source,
        touchData.utm_medium,
        touchData.utm_campaign,
        touchData.utm_term,
        touchData.utm_content,
        touchData.referrer,
        touchData.landing_path,
        capturedAt,
        now,
      ],
    );
    const row = res.rows[0]!;
    rows.push({ id: row.id, touch: t, captured_at: new Date(row.captured_at).toISOString() });
    events.push(
      await buildEvent({
        topic: 'attribution.recorded',
        organizationId: input.organizationId,
        storeId: input.storeId,
        aggregateType: 'attribution',
        aggregateId: row.id,
        occurredAt: now,
        ...(input.actor ? { actor: eventActor(input.actor) } : {}),
        payload: {
          attribution_id: row.id,
          order_id: input.orderId,
          cart_id: input.cartId,
          touch: t,
          utm_source: touchData.utm_source,
          utm_medium: touchData.utm_medium,
          utm_campaign: touchData.utm_campaign,
          utm_term: touchData.utm_term,
          utm_content: touchData.utm_content,
          referrer: touchData.referrer,
          landing_path: touchData.landing_path,
          campaign_id: null,
          captured_at: capturedAt,
          recorded_at: now.toISOString(),
        },
      }),
    );
  }
  await withEvents(tx, events);
  return rows;
}
