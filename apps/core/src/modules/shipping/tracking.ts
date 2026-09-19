// Carrier tracking webhooks. Four rules, in this order:
//
//   1. Verify first. An unsigned or wrongly signed body is rejected before it is parsed — the signature is
//      checked against the RAW body with a timing-safe comparison.
//   2. Extract, don't store. The raw body is hashed (`payload_hash`) and reduced to the fields this module
//      processes — ids, tracking code, status, timestamps. No address, no scan location, reaches the row (#187).
//   3. Record before applying. The provider event id goes into `webhook_event` (unique per provider + id) in
//      the same transaction as the state change. A carrier retry conflicts on that row and changes nothing.
//   4. Move forward only. Carriers deliver scans out of order; a `delivered` that arrives before `in_transit`
//      must not be undone by the late scan, and a shipment that jumps straight to `delivered` still emits
//      `shipment.shipped` first (accounting derives cost and COGS timing from it). Ordering comes from the
//      shipment's own state machine, never from the carrier's timestamp.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Queryable, ScopedClient } from '@platform/db';
import { SYSTEM_ACTOR, type Actor } from '../../lib/audit';
import { AppError } from '../../lib/errors';
import { easyPostTrackingStatus } from './easypost-provider';
import { applyTransition, canTransition, loadShipment, type ShipmentStatus } from './shipments';
import type { TrackingStatus } from './types';
import {
  finishWebhookEvent,
  payloadHashOf,
  recordWebhookEvent,
  type TrackingExtract,
} from './webhook-events';

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
  rawBody: Buffer | string;
  /** Value of the provider's signature header (`X-Hmac-Signature` for EasyPost). */
  signature: string | null | undefined;
  /** Shared secret for this store and provider, from the environment (ADR 0006). */
  secret: string;
  organizationId: string;
  /** Resolved by the router before anything is stored (#187: an unresolvable delivery is never stored). */
  storeId: string;
  actor?: Actor | undefined;
}

export interface WebhookResult {
  /** `applied` = a shipment moved · `duplicate` = the carrier retried · `skipped` = recognised, nothing to do. */
  outcome: 'applied' | 'duplicate' | 'skipped';
  eventId: string;
  shipmentId: string | null;
  status: ShipmentStatus | null;
  reason?: string;
}

/**
 * EasyPost signs the raw body with HMAC-SHA256 and sends it as `hmac-sha256-hex=<hex>`. A missing, malformed or
 * wrong signature is a 401 — never a 200 with a log line, or a stranger could drive our shipment states.
 */
export function verifyEasyPostSignature(
  rawBody: Buffer | string,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const provided = signature.includes('=')
    ? signature.slice(signature.indexOf('=') + 1)
    : signature;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided.trim().toLowerCase(), 'utf8');
  // timingSafeEqual throws on a length mismatch; compare lengths first, still without an early-exit on content.
  return a.length === b.length && timingSafeEqual(a, b);
}

interface EasyPostWebhookBody {
  id?: unknown;
  description?: unknown;
  created_at?: unknown;
  result?: {
    id?: unknown;
    tracking_code?: unknown;
    carrier?: unknown;
    status?: unknown;
    updated_at?: unknown;
    tracking_details?: { status?: unknown; datetime?: unknown }[];
  };
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/**
 * Reduces an EasyPost `tracker.updated` body to the redacted extract. The event id is the webhook's own id
 * (`evt_…`) — what the carrier retries with, so it is the dedupe key. The status is the tracker's current state
 * rather than the last detail, because EasyPost resends the whole detail history every time. Everything else in
 * the body — the destination, scan locations, signer names — is dropped here and never stored.
 *
 * `occurred_at` is null when the carrier sent no timestamp: storing a made-up one would be worse than none.
 */
export function extractEasyPostWebhook(body: unknown): TrackingExtract | null {
  const parsed = (body ?? {}) as EasyPostWebhookBody;
  const result = parsed.result;
  const trackingCode = str(result?.tracking_code);
  const eventId = str(parsed.id);
  if (!trackingCode || !eventId) return null;
  const details = Array.isArray(result?.tracking_details) ? result.tracking_details : [];
  const last = details[details.length - 1];
  return {
    provider_event_id: eventId,
    event_type: str(parsed.description) ?? 'tracker.updated',
    tracker_id: str(result?.id),
    tracking_code: trackingCode,
    carrier: str(result?.carrier),
    status: easyPostTrackingStatus(str(result?.status) ?? str(last?.status)),
    occurred_at: str(last?.datetime) ?? str(result?.updated_at),
  };
}

/**
 * The EasyPost tracking webhook end to end: verify, hash, extract, then record and apply in one transaction, so a
 * shipment change, its outbox events and the idempotency row commit together or not at all. A failure while
 * applying rolls the row back too, so the carrier's retry processes the event again rather than finding it
 * "already seen".
 */
export async function handleEasyPostWebhook(
  client: ScopedClient,
  request: WebhookRequest,
): Promise<WebhookResult> {
  if (!verifyEasyPostSignature(request.rawBody, request.signature, request.secret)) {
    throw new AppError('unauthorized', 'invalid webhook signature');
  }
  const payloadHash = payloadHashOf(request.rawBody);
  let body: unknown;
  try {
    body = JSON.parse(
      Buffer.isBuffer(request.rawBody) ? request.rawBody.toString('utf8') : request.rawBody,
    );
  } catch {
    throw new AppError('validation_error', 'webhook body is not JSON');
  }
  const extract = extractEasyPostWebhook(body);
  if (!extract) throw new AppError('validation_error', 'webhook body is not a tracker update');
  return applyTrackingEvent(client, {
    extract,
    payloadHash,
    organizationId: request.organizationId,
    storeId: request.storeId,
    actor: request.actor ?? SYSTEM_ACTOR,
  });
}

export interface ApplyTrackingInput {
  extract: TrackingExtract;
  payloadHash: string;
  organizationId: string;
  storeId: string;
  actor: Actor;
}

/** Provider-independent half: record the delivery, find the shipment, move it forward if the scan is newer. */
export async function applyTrackingEvent(
  client: ScopedClient,
  input: ApplyTrackingInput,
): Promise<WebhookResult> {
  const { extract } = input;
  return client.transaction(async (tx) => {
    const rowId = await recordWebhookEvent(tx, input);
    if (!rowId) {
      return {
        outcome: 'duplicate',
        eventId: extract.provider_event_id,
        shipmentId: null,
        status: null,
      };
    }

    const shipmentId = await shipmentIdForTracking(tx, extract.tracking_code);
    if (!shipmentId) {
      const reason = 'no shipment with this tracking number';
      await finishWebhookEvent(tx, rowId, { status: 'skipped', shipmentId: null, reason });
      return {
        outcome: 'skipped',
        eventId: extract.provider_event_id,
        shipmentId: null,
        status: null,
        reason,
      };
    }
    const { shipment, items } = await loadShipment(tx, shipmentId);
    const target = SHIPMENT_STATUS[extract.status as TrackingStatus];
    if (!target || !canTransition(shipment.status, target)) {
      // A late or repeated scan: the row already says as much or more. Recorded, nothing changed.
      const reason = target
        ? 'shipment is already at or past this status'
        : 'carrier status is not actionable';
      await finishWebhookEvent(tx, rowId, { status: 'skipped', shipmentId, reason });
      return {
        outcome: 'skipped',
        eventId: extract.provider_event_id,
        shipmentId,
        status: shipment.status,
        reason,
      };
    }

    await applyTransition(tx, shipment, items, {
      status: target,
      // The carrier's time when it gave one, else receipt time — never a placeholder date.
      ...(extract.occurred_at ? { occurredAt: extract.occurred_at } : {}),
      actor: input.actor,
    });
    await finishWebhookEvent(tx, rowId, { status: 'processed', shipmentId });
    return { outcome: 'applied', eventId: extract.provider_event_id, shipmentId, status: target };
  });
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
