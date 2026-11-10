-- 0208 outbox_lag owner role (#737). app.outbox_lag() (0110) is SECURITY DEFINER so that platform_metrics, which has
-- no table access, can read per-store/topic aggregates of the unpublished outbox. It relied on its owner bypassing
-- row security. On managed Postgres (README "Migrations on managed Postgres") the owner is the migration role:
-- NOBYPASSRLS, and the outbox is FORCE RLS, so the function ran under tenant_isolation with no tenant context and
-- returned 0 rows — the outbox-lag panel and SLO said "no lag" while the relay was stuck.
--
-- Fix: the function is owned by a dedicated role that exists for this one read:
--   platform_outbox_lag  NOLOGIN NOINHERIT NOBYPASSRLS, no membership in anything;
--   SELECT on six outbox columns only (organization_id, store_id, topic, occurred_at, published_at, attempts) —
--     never id, aggregate_id, payload, headers or last_error;
--   one policy, outbox_lag_read: FOR SELECT TO platform_outbox_lag USING (published_at IS NULL).
-- FORCE RLS stays on; every other role is still under tenant_isolation only. The function's body, columns and
-- grants are unchanged (it still returns aggregates only), and platform_metrics keeps EXECUTE and nothing else.
-- platform_app loses EXECUTE: the result spans every organization, and the relay reads its own organization's
-- backlog directly since #751.
--
-- Why not the set_config scope pattern of 0207: app.scope = 'organization' still needs one app.organization_id,
-- and the function could not even list the organizations (organization and outbox are both forced). Iterating
-- per organization is impossible without already seeing every row.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_outbox_lag') THEN
    CREATE ROLE platform_outbox_lag NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

-- USAGE on app: tenant_isolation (applied to every role) calls app.current_organization_id() / app.can_access_store().
GRANT USAGE ON SCHEMA app TO platform_outbox_lag;
GRANT SELECT (organization_id, store_id, topic, occurred_at, published_at, attempts) ON outbox
  TO platform_outbox_lag;
CREATE POLICY outbox_lag_read ON outbox AS PERMISSIVE FOR SELECT TO platform_outbox_lag
  USING (published_at IS NULL);

COMMENT ON FUNCTION app.outbox_lag() IS
  'Per-store, per-topic unpublished outbox counts for the observability stack. Aggregates only: no payload, no headers. SECURITY DEFINER owned by platform_outbox_lag (0208), which reads unpublished outbox rows of every organization through policy outbox_lag_read; pinned search_path.';

-- Before the hand-over: only the owner may change the function's grants.
REVOKE EXECUTE ON FUNCTION app.outbox_lag() FROM platform_app;

-- Hand the function to the role. ALTER ... OWNER TO needs (Postgres 16) SET on the new owner and CREATE on the
-- schema for the new owner. The migration role that created platform_outbox_lag holds ADMIN on it (without SET or
-- INHERIT), so it grants itself a membership for this statement and the role CREATE on app, and takes both back.
-- Neither is left in place: a member would inherit outbox_lag_read. A later migration that replaces the function
-- wraps its CREATE OR REPLACE in the same GRANT ... TO CURRENT_USER / REVOKE (replacing needs owner membership).
GRANT platform_outbox_lag TO CURRENT_USER;
GRANT CREATE ON SCHEMA app TO platform_outbox_lag;
ALTER FUNCTION app.outbox_lag() OWNER TO platform_outbox_lag;
REVOKE CREATE ON SCHEMA app FROM platform_outbox_lag;
REVOKE platform_outbox_lag FROM CURRENT_USER;
