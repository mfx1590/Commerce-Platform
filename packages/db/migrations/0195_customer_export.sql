-- Landed from CONTRACT CHANGE #498 (window 13, task 13.3 / #472), manager decision 2026-10-18.
-- 0195 customer_export: a delivered GDPR export (CONTRACT CHANGE #498, window 13 #472; manager decisions 2026-10-18).
-- One row per `customer.export_requested` event (event_id UNIQUE = the consumer's idempotency), the bundle gzip JSON
-- in bytea with its sha256 and size until object storage exists (#361), a hard size cap enforced by the core,
-- 30-day TTL. Erasure deletes every export of the customer, bundle included, in the erasure transaction. After the
-- TTL the bundle is purged and the bare row (ids, timestamps, status) stays as the record that the request was
-- served — retention of those rows is on the lawyer list.
CREATE TABLE customer_export (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organization(id),
  store_id           uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  customer_id        uuid NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  event_id           uuid NOT NULL UNIQUE,                       -- the customer.export_requested outbox row
  requested_by       uuid NOT NULL,                              -- staff_user id or customer id (the event's)
  requested_by_type  text NOT NULL CHECK (requested_by_type IN ('staff', 'customer')),
  requested_at       timestamptz NOT NULL,                       -- the event's requested_at
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'expired')),
  reason             text,                                       -- why it never became ready: 'customer_gone' | 'too_large'
  format             text,                                       -- 'customer-export/v1'
  bundle             bytea,                                      -- gzip(JSON), NULL once purged or never built
  bundle_sha256      text,
  bundle_size        integer,                                    -- compressed bytes
  ready_at           timestamptz,
  expires_at         timestamptz,
  purged_at          timestamptz,
  download_count     integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_export_customer_idx ON customer_export (customer_id, created_at DESC);
CREATE INDEX customer_export_pending_idx ON customer_export (store_id, status) WHERE status = 'pending';
CREATE INDEX customer_export_expiry_idx ON customer_export (expires_at) WHERE status = 'ready';
SELECT app.apply_rls('customer_export', 'store');
CREATE TRIGGER set_updated_at BEFORE UPDATE ON customer_export
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
