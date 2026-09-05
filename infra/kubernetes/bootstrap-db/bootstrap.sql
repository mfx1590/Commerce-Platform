-- Creates the application role on a managed Postgres instance, with the password Terraform
-- generated and stored in Secrets Manager.
--
-- Run BEFORE the migrations. packages/db/migrations/0001_app_schema.sql creates `platform_app` with
-- a well-known local-dev password only when the role does not already exist ("staging/production
-- set it from Vault with ALTER ROLE"); this script is that step. Running it first means the
-- dev-default password never exists in a cloud environment, not even for a moment.
--
-- Idempotent: safe to re-run on every deploy, which is what the ArgoCD PreSync hook does.
-- The migrations own every GRANT on tables and sequences (0009_rls_policies.sql) and that is
-- deliberately not repeated here, so the application role's privileges have exactly one home.
--
--   psql -v ON_ERROR_STOP=1 -v app_username="$APP_USERNAME" -v app_password="$APP_PASSWORD" \
--        -f bootstrap.sql
--
-- The values arrive as psql variables and are handed to Postgres through set_config + format(%I/%L),
-- never pasted into a SQL string, so a password containing a quote cannot break or rewrite the
-- statement.

\set ON_ERROR_STOP on

SELECT set_config('bootstrap.app_username', :'app_username', false);
SELECT set_config('bootstrap.app_password', :'app_password', false);

DO $$
DECLARE
  v_user text := current_setting('bootstrap.app_username');
  v_pass text := current_setting('bootstrap.app_password');
BEGIN
  IF v_user = '' OR v_pass = '' THEN
    RAISE EXCEPTION 'app_username and app_password must both be set';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_user) THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOBYPASSRLS', v_user, v_pass);
    RAISE NOTICE 'created role %', v_user;
  ELSE
    -- Rotation path: task 2.6 rotates the secret, the next sync re-applies it.
    EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOBYPASSRLS', v_user, v_pass);
    RAISE NOTICE 'role % already existed, password re-applied', v_user;
  END IF;

  -- Belt and braces: a SUPERUSER or BYPASSRLS application role silently defeats every tenant policy
  -- in 0009_rls_policies.sql. Fail loudly rather than serve one store another store's orders.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role % must not be SUPERUSER or BYPASSRLS', v_user;
  END IF;
END
$$;

-- RDS revokes PUBLIC CONNECT on a created database, so the role needs this explicitly.
GRANT CONNECT ON DATABASE :"DBNAME" TO :"app_username";

-- Leave nothing behind in the session.
SELECT set_config('bootstrap.app_password', '', false);
