// The idempotency record behind every carrier webhook, on the shared `webhook_event` table accepted in #187
// (migration 0140, shared with payments). One row per delivered provider event; a redelivery conflicts on
// `UNIQUE (provider, provider_event_id)`, inserts nothing, and is answered "already seen" without touching a
// shipment or emitting a second event.
//
// NO RAW PAYLOADS (#187): `payload` holds only the redacted extract this module processes — ids, the tracking
// code, the status and timestamps, never an address — and `payload_hash` is the sha256 of the raw request body.
import { createHash } from 'node:crypto';
import type { Queryable } from '@platform/db';

export const TRACKING_WEBHOOK_PROVIDER = 'easypost';

/** `webhook_event.status` (#187): received → processed | skipped (recognised, no-op) | failed. */
export type WebhookEventStatus = 'received' | 'processed' | 'skipped' | 'failed';

/**
 * What shipping keeps of a tracking delivery — the fields it processes and nothing else. No address, no city: a
 * carrier's scan location is part of the destination's trail, so it is dropped at extraction.
 */
export interface TrackingExtract {
  provider_event_id: string;
  event_type: string;
  /** The carrier's tracker object (`trk_…`), stored as `provider_object_id`. */
  tracker_id: string | null;
  tracking_code: string;
  carrier: string | null;
  status: string;
  /** Carrier timestamp for the scan; null when the carrier omitted it. Audit only — never used for ordering. */
  occurred_at: string | null;
}

export interface RecordInput {
  organizationId: string;
  storeId: string;
  extract: TrackingExtract;
  payloadHash: string;
}

/** sha256 hex of the exact bytes received — computed before parsing, stored as `payload_hash`. */
export function payloadHashOf(rawBody: Buffer | string): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/**
 * Inserts the delivery if this provider event has not been seen. Returns the new row id, or `null` for a
 * redelivery — the caller must then do nothing else. Runs on the caller's transaction, so the record and the
 * state change commit or roll back together.
 */
export async function recordWebhookEvent(
  tx: Queryable,
  input: RecordInput,
): Promise<string | null> {
  const { extract } = input;
  const r = await tx.query<{ id: string }>(
    `INSERT INTO webhook_event (organization_id, store_id, provider, provider_event_id, event_type,
       provider_object_id, occurred_at, status, payload, payload_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'received', $8::jsonb, $9)
     ON CONFLICT (provider, provider_event_id) DO NOTHING
     RETURNING id`,
    [
      input.organizationId,
      input.storeId,
      TRACKING_WEBHOOK_PROVIDER,
      extract.provider_event_id,
      extract.event_type,
      extract.tracker_id,
      extract.occurred_at,
      JSON.stringify(extract),
      input.payloadHash,
    ],
  );
  return r.rows[0]?.id ?? null;
}

/** Closes a row this call recorded: its outcome, the shipment it resolved to, and why when it was skipped. */
export async function finishWebhookEvent(
  tx: Queryable,
  rowId: string,
  outcome: {
    status: Exclude<WebhookEventStatus, 'received'>;
    shipmentId: string | null;
    reason?: string | null;
  },
): Promise<void> {
  await tx.query(
    `UPDATE webhook_event
        SET status = $2, aggregate_type = CASE WHEN $3::uuid IS NULL THEN NULL ELSE 'shipment' END,
            aggregate_id = $3::uuid, failure_reason = $4, processed_at = now(), updated_at = now()
      WHERE id = $1`,
    [rowId, outcome.status, outcome.shipmentId, outcome.reason ?? null],
  );
}
