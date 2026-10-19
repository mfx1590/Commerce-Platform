-- Landed from CONTRACT CHANGE #512 (window 2, #483), manager decision 2026-10-19.
-- 0199 customer_erasure_claim (CONTRACT CHANGE #512 for #483, window 2): one row per `customer.erased` outbox event the
-- erasure consumer has settled, and what became of it. UNIQUE (event_id) is the replay guard: a settled event is
-- never re-read, so Keycloak is never called again for it. A row is written only after a DEFINITIVE outcome; a
-- Keycloak 503 writes nothing and the next poll retries. No personal data: ids and an outcome label only — never
-- the Keycloak subject, never an email.
CREATE TABLE customer_erasure_claim (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  -- outbox.id of the customer.erased event this row settles.
  event_id        uuid NOT NULL,
  -- outbox.seq of the same event: the order events are processed in.
  event_seq       bigint NOT NULL,
  -- payload.customer_id of the event (the erased row).
  customer_id     uuid NOT NULL,
  -- nothing_to_delete  = no erased row / no tombstone subject (a guest) — nothing in Keycloak to delete
  -- kept_live_elsewhere = another non-erased row of the organization still carries the subject; the user stays
  -- deleted             = the customers-realm user was deleted by this event
  -- already_gone        = Keycloak had no such user any more (deleted earlier, or by hand)
  outcome         text NOT NULL CHECK (outcome IN ('nothing_to_delete', 'kept_live_elsewhere', 'deleted', 'already_gone')),
  -- non-erased rows of the organization that still carried the subject at the time (0 unless kept).
  live_rows       integer NOT NULL DEFAULT 0 CHECK (live_rows >= 0),
  claimed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id)
);
CREATE INDEX customer_erasure_claim_customer_idx ON customer_erasure_claim (customer_id);
CREATE INDEX customer_erasure_claim_store_seq_idx ON customer_erasure_claim (store_id, event_seq);

-- RLS (ADR 0001), store-level like every other store table; no updated_at (rows are written once).
SELECT app.apply_rls('customer_erasure_claim', 'store');

-- Claims are written once (manager condition on #512, 0194's append-only precedent): the application role may
-- insert and read, never change or remove a claim. A store delete still cascades (FK action, table owner).
REVOKE UPDATE, DELETE ON customer_erasure_claim FROM platform_app;
