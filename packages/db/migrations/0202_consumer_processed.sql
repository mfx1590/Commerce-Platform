-- Manager decision 2026-10-23 (Phase 4 wave 2 kickoff, #548 / #553): one shared processed store for every bus
-- consumer built on the events-v1 consumer SDK (packages/events `createPgProcessedStore(q, 'consumer_processed')`).
-- One row per (consumer group, outbox event) the group has finished; the SDK checks it before a handler runs and
-- writes it inside the handler's own transaction (`ctx.markProcessed(tx)`), so side effects and the mark commit
-- together. PK (group_id, outbox_id) is the replay guard. No personal data: a group name and an outbox id only.
-- organization_id defaults to the session's organization: the SDK's INSERT names only (group_id, outbox_id).
CREATE TABLE consumer_processed (
  organization_id uuid NOT NULL DEFAULT app.current_organization_id() REFERENCES organization(id),
  group_id        text NOT NULL CHECK (group_id ~ '^[a-z][a-z0-9_.-]*$'),
  -- outbox.id of the event (the `outbox_id` header on the bus).
  outbox_id       uuid NOT NULL,
  processed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, outbox_id)
);
CREATE INDEX consumer_processed_org_group_idx ON consumer_processed (organization_id, group_id, processed_at);

-- RLS (ADR 0001): consumers run in organization scope (they read every store's events); a store-scoped session
-- reads and writes none (0192's kind).
SELECT app.apply_rls('consumer_processed', 'organization_only');

-- Written once: the application role may insert and read, never change a mark. DELETE stays (a consumer that is
-- rebuilt from scratch clears its own group's rows in organization scope).
REVOKE UPDATE ON consumer_processed FROM platform_app;
