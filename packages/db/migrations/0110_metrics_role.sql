-- 0110 metrics: a read-only role for the observability stack (infra task 2.5).
--
-- The outbox-lag dashboard needs per-store counts of unpublished events. Giving a metrics exporter
-- SELECT on `outbox` would expose every event payload (order totals, ids, hashed emails) and would
-- need an RLS exemption to see all stores at once. Instead it gets EXECUTE on one SECURITY DEFINER
-- function that returns aggregates only — no payload column is reachable, and the raw table stays
-- under RLS for everyone else.
--
-- Numbered after 0100 (packages/events) because it reads `outbox`: the runner applies both
-- directories in one name-ordered sequence.
-- The function is owned by the migration role and marked SECURITY DEFINER, so it reads `outbox`
-- with the owner's rights; `search_path` is pinned so a caller cannot shadow `outbox` with their own
-- table and trick the definer into reading it.

CREATE OR REPLACE FUNCTION app.outbox_lag()
RETURNS TABLE (
  organization_id   uuid,
  store_id          uuid,
  topic             text,
  unpublished       bigint,
  oldest_occurred_at timestamptz,
  max_attempts      integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
  SELECT o.organization_id,
         o.store_id,
         o.topic,
         count(*)            AS unpublished,
         min(o.occurred_at)  AS oldest_occurred_at,
         max(o.attempts)     AS max_attempts
  FROM outbox o
  WHERE o.published_at IS NULL
  GROUP BY o.organization_id, o.store_id, o.topic
$$;

COMMENT ON FUNCTION app.outbox_lag() IS
  'Per-store, per-topic unpublished outbox counts for the observability stack. Aggregates only: no payload, no headers. SECURITY DEFINER with a pinned search_path.';

-- Read-only role for the metrics exporter. Local/dev password only; staging and production set it
-- from Vault with ALTER ROLE, the same as platform_app (see 0001).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_metrics') THEN
    CREATE ROLE platform_metrics LOGIN PASSWORD 'platform_metrics' NOBYPASSRLS;
  END IF;
END $$;

-- Nothing but the aggregate function: no schema-wide grants, no table access.
GRANT USAGE ON SCHEMA app TO platform_metrics;
REVOKE ALL ON FUNCTION app.outbox_lag() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.outbox_lag() TO platform_metrics;
GRANT EXECUTE ON FUNCTION app.outbox_lag() TO platform_app;
