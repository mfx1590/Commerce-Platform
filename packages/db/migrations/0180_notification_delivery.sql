-- LANDED in @platform/db 0.3.3 (CONTRACT CHANGE #393, window 17, #360): 0180 notification_delivery, proposal verbatim.
--
-- Kept here verbatim until the main window applies it, the way 0170_cart_recovery.sql travelled (#244): the
-- notifications tests apply this file to their own throwaway database, so the worker is exercised against
-- exactly the schema being proposed. When it lands on main this copy is deleted in a small follow-up.
--
-- One table: `notification_delivery` — one row per outbox event the worker has claimed, and what became of it.
--
-- Why a row per EVENT and not per order: "exactly once per event" is a property of the event id. `order.placed`
-- and `shipment.shipped` can be re-delivered, the cursor can be reset, the worker can be re-run from an older
-- position — `UNIQUE (event_id)` is what makes a second email impossible, not the consumer's memory. The cursor
-- (`marketing_cursor`, name `notifications`) is only an optimisation so a run does not rescan the whole outbox.
--
-- What is NOT here: the recipient. The address is read from `"order"` at send time and goes to the transport
-- and nowhere else — not into this row, not into a log line. A report over this table can say how many
-- confirmations went out and how many are stuck without knowing who any of them went to.
CREATE TABLE notification_delivery (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organization(id),
  store_id            uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  -- outbox.id of the event this delivery answers. The replay guard.
  event_id            uuid NOT NULL,
  -- outbox.seq of the same event: the order deliveries are attempted in (rows claimed in one transaction
  -- share a created_at, so created_at cannot order them).
  event_seq           bigint NOT NULL,
  topic               text NOT NULL,
  -- the order id (order.placed) or the shipment id (shipment.shipped); the row is re-read from the database
  -- at send time, the payload is never the record source.
  aggregate_id        uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('order_confirmation', 'shipment_shipped')),
  -- the locale the email was rendered in; set when the send is attempted.
  locale              text,
  -- pending  = claimed, not attempted yet (attempted_at IS NULL) — or attempted with no recorded outcome
  --            (attempted_at IS NOT NULL): the process died between the send and the mark. Such a row is
  --            "stuck": it is never retried automatically, because the email may already be in the inbox and a
  --            duplicate confirmation is worse than one the owner has to look at. /health counts them.
  -- sent     = the transport accepted it.
  -- failed   = the transport refused it; retried on later runs until `attempts` reaches the worker's limit.
  -- skipped  = the source row no longer exists (an order deleted before the worker got to it).
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  attempted_at        timestamptz,
  sent_at             timestamptz,
  provider            text,
  provider_message_id text,
  -- a short provider error label (HTTP status + error name); never the response body, never an address.
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX notification_delivery_store_status_idx ON notification_delivery (store_id, status, event_seq);
CREATE INDEX notification_delivery_aggregate_idx ON notification_delivery (aggregate_id);

-- RLS (ADR 0001) + updated_at trigger, like every other store-level table.
SELECT app.apply_rls('notification_delivery', 'store');
CREATE TRIGGER set_updated_at BEFORE UPDATE ON notification_delivery
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
