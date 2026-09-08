// The idempotency record behind every carrier webhook: one row per provider event id, inserted before the
// event is applied. A duplicate delivery — carriers retry until they get a 2xx — conflicts on that row and is
// answered "already seen" without touching a shipment or emitting a second event.
//
// The `webhook_event` table is SHARED with window 7 (payments) and is not in db 0.2.0 yet: window 7 files the
// CONTRACT CHANGE, shipping's requirements are on issue #125. `PROPOSED_WEBHOOK_EVENT_SQL` below is the shape
// this module builds against and the tests create; when the real migration lands, only that constant and this
// comment go away.
import type { Queryable } from '@platform/db';

export type WebhookEventStatus = 'received' | 'processed' | 'ignored' | 'failed';

export interface WebhookEventRecord {
  provider: string;
  externalId: string;
  topic: string;
  organizationId: string;
  storeId: string | null;
  /** The provider's own timestamp, not ours — tracking scans arrive out of order. */
  occurredAt: string | null;
  payload: Record<string, unknown>;
}

export interface WebhookEventStore {
  /**
   * Records the event if it has not been seen. `false` = a duplicate delivery; the caller must do nothing else.
   * Runs on the caller's transaction so the record and the state change commit or roll back together.
   */
  record(tx: Queryable, event: WebhookEventRecord): Promise<boolean>;
  /** Marks the outcome of an event this call recorded. */
  finish(
    tx: Queryable,
    key: { provider: string; externalId: string },
    status: WebhookEventStatus,
    error?: string | null,
  ): Promise<void>;
}

/**
 * The proposed shared table. Kept here (not in packages/db, which is frozen and window 1's) so this module and
 * its tests have something real to run against while the CONTRACT CHANGE is open.
 *
 * `UNIQUE (provider, external_id)` — not a global unique id: EasyPost's and Stripe's id spaces are unrelated.
 * `occurred_at` is nullable and separate from `received_at` — a `delivered` scan can reach us before the
 * `in_transit` one, and ordering must use the carrier's clock.
 */
export const PROPOSED_WEBHOOK_EVENT_SQL = `
CREATE TABLE IF NOT EXISTS webhook_event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  store_id        uuid,
  provider        text NOT NULL,
  topic           text NOT NULL,
  external_id     text NOT NULL,
  status          text NOT NULL DEFAULT 'received'
                    CHECK (status IN ('received','processed','ignored','failed')),
  occurred_at     timestamptz,
  received_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  error           text,
  UNIQUE (provider, external_id)
);`;

/** Table-backed store. Works against the shared table the moment the migration lands. */
export const sqlWebhookEventStore: WebhookEventStore = {
  async record(tx, event): Promise<boolean> {
    const r = await tx.query(
      `INSERT INTO webhook_event (organization_id, store_id, provider, topic, external_id, occurred_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (provider, external_id) DO NOTHING
       RETURNING id`,
      [
        event.organizationId,
        event.storeId,
        event.provider,
        event.topic,
        event.externalId,
        event.occurredAt,
        JSON.stringify(event.payload),
      ],
    );
    return (r.rowCount ?? 0) > 0;
  },
  async finish(tx, key, status, error = null): Promise<void> {
    await tx.query(
      `UPDATE webhook_event SET status = $3, error = $4, processed_at = now()
        WHERE provider = $1 AND external_id = $2`,
      [key.provider, key.externalId, status, error],
    );
  },
};

/** In-memory store for tests and for a local run without the shared table. */
export function createMemoryWebhookEventStore(): WebhookEventStore & {
  seen(): { provider: string; externalId: string; status: WebhookEventStatus }[];
} {
  const rows = new Map<string, { record: WebhookEventRecord; status: WebhookEventStatus }>();
  const keyOf = (provider: string, externalId: string) => `${provider}|${externalId}`;
  return {
    async record(_tx, event) {
      const key = keyOf(event.provider, event.externalId);
      if (rows.has(key)) return false;
      rows.set(key, { record: event, status: 'received' });
      return true;
    },
    async finish(_tx, key, status) {
      const row = rows.get(keyOf(key.provider, key.externalId));
      if (row) row.status = status;
    },
    seen() {
      return [...rows.entries()].map(([key, row]) => ({
        provider: key.split('|')[0]!,
        externalId: row.record.externalId,
        status: row.status,
      }));
    },
  };
}

let store: WebhookEventStore = sqlWebhookEventStore;

/** Replaces the store (the in-memory one in unit tests). Returns the previous one. */
export function setWebhookEventStore(next: WebhookEventStore): WebhookEventStore {
  const previous = store;
  store = next;
  return previous;
}

export function currentWebhookEventStore(): WebhookEventStore {
  return store;
}
