// Carrier tracking webhooks. Three rules, in this order:
//
//   1. Verify first. An unsigned or wrongly signed body is rejected before it is parsed — the signature is
//      checked against the RAW body with a timing-safe comparison.
//   2. Record before applying. Every provider event id goes into `webhook_event` (unique per provider + id) in
//      the same transaction as the state change. A carrier retry conflicts on that row and changes nothing.
//   3. Move forward only. Carriers deliver scans out of order; a `delivered` that arrives before `in_transit`
//      must not be undone by the late scan, and a shipment that jumps straight to `delivered` still emits
//      `shipment.shipped` first (accounting derives cost and COGS timing from it).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ScopedClient, Queryable } from '@platform/db';
import { AppError } from '../../lib/errors';
import type { Actor } from '../../lib/audit';
import { easyPostTrackingStatus } from './easypost-provider';
import { applyTransition, canTransition, loadShipment, type ShipmentStatus } from './shipments';
import { currentWebhookEventStore } from './webhook-events';
import type { TrackingEvent, TrackingStatus } from './types';

/** Carrier tracking status → our shipment status. `unknown` and `pre_transit` move nothing. */
const SHIPMENT_STATUS: Partial<Record<TrackingStatus, ShipmentStatus>> = {
  in_transit: 'in_transit',
  out_for_delivery: 'in_transit',
  available_for_pickup: 'in_transit',
  delivered: 'delivered',
  return_to_sender: 'failed',
  failure: 'failed',
  cancelled: 'cancelled',
};

export interface WebhookRequest {
  /** Exactly the bytes that were signed. Never re-serialise a parsed body before verifying. */
  rawBody: string;
  /** Value of the provider's signature header (`X-Hmac-Signature` for EasyPost). */
  signature: string | null;
  /** Shared secret for this store and provider, from the environment (ADR 0006). */
  secret: string;
  organizationId: string;
  storeId: string | null;
  actor: Actor;
}

export interface WebhookResult {
  /** `applied` = a shipment moved · `duplicate` = the carrier retried · `ignored` = nothing to do. */
  outcome: 'applied' | 'duplicate' | 'ignored';
  eventId: string;
  shipmentId: string | null;
  status: ShipmentStatus | null;
  reason?: string;
}

/**
 * EasyPost signs the raw body with HMAC-SHA256 and sends it as `hmac-sha256-hex=<hex>`. A missing, malformed or
 * wrong signature is a 401 — never a 200 with a log line, or a carrier could drive our shipment states.
 */
export function verifyEasyPostSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const provided = signature.includes('=')
    ? signature.slice(signature.indexOf('=') + 1)
    : signature;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided.trim().toLowerCase(), 'utf8');
  // timingSafeEqual throws on a length mismatch; compare lengths first, still without an early-exit on content.
  return a.length === b.length && timingSafeEqual(a, b);
}

interface EasyPostWebhookBody {
  id?: string;
  description?: string;
  result?: {
    id?: string;
    tracking_code?: string;
    carrier?: string;
    status?: string;
    status_detail?: string;
    updated_at?: string;
    tracking_details?: {
      object_id?: string;
      status?: string;
      message?: string;
      datetime?: string;
      tracking_location?: {
        city?: string | null;
        state?: string | null;
        country?: string | null;
      } | null;
    }[];
  };
}

/**
 * Reads an EasyPost `tracker.updated` body into the one scan it reports. The event id is the webhook's own id
 * (`evt_…`) — that is what the carrier retries with, so it is the idempotency key. The status is the tracker's
 * current state rather than the last detail, because EasyPost sends the whole detail history every time.
 */
export function parseEasyPostWebhook(body: unknown): {
  eventId: string;
  topic: string;
  event: TrackingEvent;
} | null {
  const parsed = body as EasyPostWebhookBody;
  const result = parsed?.result;
  const trackingNumber = result?.tracking_code;
  if (!trackingNumber) return null;
  const eventId = parsed.id ?? result?.id ?? null;
  if (!eventId) return null;
  const details = result?.tracking_details ?? [];
  const last = details[details.length - 1];
  return {
    eventId,
    topic: parsed.description ?? 'tracker.updated',
    event: {
      eventId,
      trackingNumber,
      carrier: result?.carrier ?? 'unknown',
      status: easyPostTrackingStatus(result?.status ?? last?.status),
      statusDetail: result?.status_detail ?? last?.message ?? null,
      occurredAt: last?.datetime ?? result?.updated_at ?? new Date(0).toISOString(),
      location: last?.tracking_location
        ? {
            city: last.tracking_location.city ?? null,
            region: last.tracking_location.state ?? null,
            country: last.tracking_location.country ?? null,
          }
        : null,
    },
  };
}

/**
 * The EasyPost tracking webhook end to end. Verifies, records, applies — one transaction, so a shipment change,
 * its outbox events and the idempotency row commit together or not at all.
 */
export async function handleEasyPostWebhook(
  client: ScopedClient,
  request: WebhookRequest,
): Promise<WebhookResult> {
  if (!verifyEasyPostSignature(request.rawBody, request.signature, request.secret)) {
    throw new AppError('unauthorized', 'invalid webhook signature');
  }
  let body: unknown;
  try {
    body = JSON.parse(request.rawBody);
  } catch {
    throw new AppError('validation_error', 'webhook body is not JSON');
  }
  const parsed = parseEasyPostWebhook(body);
  if (!parsed) {
    throw new AppError('validation_error', 'webhook body is not a tracker update');
  }
  return applyTrackingEvent(client, {
    provider: 'easypost',
    topic: parsed.topic,
    event: parsed.event,
    payload: body as Record<string, unknown>,
    organizationId: request.organizationId,
    storeId: request.storeId,
    actor: request.actor,
  });
}

export interface ApplyTrackingInput {
  provider: string;
  topic: string;
  event: TrackingEvent;
  /** Verified body, stored on the idempotency row for replay. May contain an address: it never leaves the row. */
  payload: Record<string, unknown>;
  organizationId: string;
  storeId: string | null;
  actor: Actor;
}

/** Provider-independent half: record the event, find the shipment, move it forward if the scan is newer. */
export async function applyTrackingEvent(
  client: ScopedClient,
  input: ApplyTrackingInput,
): Promise<WebhookResult> {
  const store = currentWebhookEventStore();
  return client.transaction(async (tx) => {
    const fresh = await store.record(tx, {
      provider: input.provider,
      externalId: input.event.eventId,
      topic: input.topic,
      organizationId: input.organizationId,
      storeId: input.storeId,
      occurredAt: input.event.occurredAt,
      payload: input.payload,
    });
    if (!fresh) {
      return {
        outcome: 'duplicate',
        eventId: input.event.eventId,
        shipmentId: null,
        status: null,
      };
    }

    const shipmentId = await shipmentIdForTracking(tx, input.event.trackingNumber);
    if (!shipmentId) {
      await store.finish(tx, keyOf(input), 'ignored', 'no shipment with this tracking number');
      return {
        outcome: 'ignored',
        eventId: input.event.eventId,
        shipmentId: null,
        status: null,
        reason: 'unknown tracking number',
      };
    }
    const { shipment, items } = await loadShipment(tx, shipmentId);
    const target = SHIPMENT_STATUS[input.event.status];
    if (!target || !canTransition(shipment.status, target)) {
      // A late or repeated scan: the row already says as much or more. Recorded, nothing changed.
      await store.finish(
        tx,
        keyOf(input),
        'ignored',
        target ? 'not a forward transition' : 'status not mapped',
      );
      return {
        outcome: 'ignored',
        eventId: input.event.eventId,
        shipmentId,
        status: shipment.status,
        reason: target
          ? 'shipment is already at or past this status'
          : 'carrier status is not actionable',
      };
    }

    await applyTransition(tx, shipment, items, {
      status: target,
      occurredAt: input.event.occurredAt,
      actor: input.actor,
    });
    await store.finish(tx, keyOf(input), 'processed');
    return { outcome: 'applied', eventId: input.event.eventId, shipmentId, status: target };
  });
}

function keyOf(input: ApplyTrackingInput) {
  return { provider: input.provider, externalId: input.event.eventId };
}

async function shipmentIdForTracking(
  tx: Queryable,
  trackingNumber: string,
): Promise<string | null> {
  const r = await tx.query<{ id: string }>(
    `SELECT id FROM shipment WHERE tracking_number = $1 ORDER BY created_at DESC LIMIT 1`,
    [trackingNumber],
  );
  return r.rows[0]?.id ?? null;
}
