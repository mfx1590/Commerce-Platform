-- 0100 outbox: transactional outbox (ADR 0003). Applied by the packages/db runner together with core migrations.
-- Producers (apps/core) INSERT here in the same transaction as the state change. The relay (window 14) reads
-- unpublished rows in id order, publishes to Redpanda with key = id, then sets published_at.
CREATE TABLE outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid REFERENCES store(id),
  topic           text NOT NULL,
  version         integer NOT NULL CHECK (version >= 1),
  aggregate_type  text NOT NULL,
  aggregate_id    uuid NOT NULL,
  payload         jsonb NOT NULL,
  headers         jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  -- monotonic ordering for the relay (uuid v4 is not sortable)
  seq             bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX outbox_unpublished_idx ON outbox (seq) WHERE published_at IS NULL;
CREATE INDEX outbox_aggregate_idx ON outbox (aggregate_type, aggregate_id, seq);

-- RLS: producers write through the tenant client (store or organization scope); the relay runs in a dedicated
-- organization-scoped session per organization. Store-scoped sessions never see other stores' events.
SELECT app.apply_rls('outbox', 'store_nullable');

-- Producers may only INSERT; only the relay (organization scope, app role) updates published_at/attempts.
GRANT SELECT, INSERT, UPDATE ON outbox TO platform_app;
REVOKE DELETE ON outbox FROM platform_app;
