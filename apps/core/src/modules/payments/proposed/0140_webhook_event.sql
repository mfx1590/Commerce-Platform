-- 0140 webhook_event: inbound provider webhooks (Stripe — window 7 #125; carrier tracking — window 8 #131).
-- One row per delivered provider event; exactly-once via the (provider, provider_event_id) unique constraint.
-- NO RAW PAYLOADS: `payload` is the consumer's REDACTED extract (ids, amounts, statuses — never an address,
-- email or name); `payload_hash` is sha256 of the raw body for dedupe/audit. Replay reprocesses the extract.

CREATE TABLE webhook_event (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organization(id),
  store_id           uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  provider           text NOT NULL,                -- 'stripe' | 'easypost' | …
  provider_event_id  text NOT NULL,                -- Stripe evt_…, EasyPost event id: the dedupe key
  event_type         text NOT NULL,                -- 'payment_intent.succeeded', 'tracker.updated', …
  provider_object_id text,                         -- the provider object the event is about (pi_…, trk_…)
  aggregate_type     text CHECK (aggregate_type IN ('payment','refund','shipment')),
  aggregate_id       uuid,                         -- our row, once the consumer resolved it (NULL = unmatched)
  occurred_at        timestamptz,                  -- provider/carrier timestamp FROM THE PAYLOAD; nullable —
                                                   -- carriers omit or backdate it (window 8), ordering logic
                                                   -- must not depend on it
  received_at        timestamptz NOT NULL DEFAULT now(),  -- when WE got the delivery (never null, monotonic-ish)
  status             text NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received','processed','skipped','failed')),
  processed_at       timestamptz,
  failure_reason     text,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- redacted extract, consumer-defined shape
  payload_hash       text NOT NULL,                -- sha256 hex of the raw request body
  replay_count       integer NOT NULL DEFAULT 0,   -- incremented by the replay CLI
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX webhook_event_object_idx   ON webhook_event (provider, provider_object_id);
CREATE INDEX webhook_event_store_recv_idx ON webhook_event (store_id, received_at DESC);
CREATE INDEX webhook_event_unprocessed_idx ON webhook_event (received_at) WHERE status IN ('received','failed');

SELECT app.apply_rls('webhook_event', 'store');
CREATE TRIGGER set_updated_at BEFORE UPDATE ON webhook_event
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
