-- 0001 app schema: tenant-context functions, helper triggers, application role.
-- Context is set per transaction by packages/db createTenantClient via set_config(..., true).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_organization_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.organization_id', true), '')::uuid
$$;

-- 'organization' = HQ scope (all stores of the org), 'store' = only app.store_ids, anything else = no rows.
CREATE OR REPLACE FUNCTION app.current_scope() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('app.scope', true), ''), 'none')
$$;

CREATE OR REPLACE FUNCTION app.current_store_ids() RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT coalesce(string_to_array(nullif(current_setting('app.store_ids', true), ''), ',')::uuid[], '{}'::uuid[])
$$;

CREATE OR REPLACE FUNCTION app.current_actor_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.actor_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.can_access_store(p_store_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_organization_id() IS NOT NULL AND (
    app.current_scope() = 'organization'
    OR (app.current_scope() = 'store' AND p_store_id = ANY (app.current_store_ids()))
  )
$$;

CREATE OR REPLACE FUNCTION app.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Application role: subject to RLS (NOBYPASSRLS). The password below is the docker-compose default only;
-- staging/production set it from Vault with ALTER ROLE. Skipped when the role already exists.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    CREATE ROLE platform_app LOGIN PASSWORD 'platform_app' NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA app TO platform_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO platform_app;
