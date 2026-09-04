# @platform/db

## Purpose

Plain SQL migrations for every core entity (all rows carry organization_id, store-level rows also store_id),
PostgreSQL row-level-security policies, the migration runner, the tenant-scoped client, the seed loader, and
test helpers. Tests prove that a session for store A cannot read, insert, or move rows of store B.

## Owner

main window. Window 1 (core) may propose migrations via PR; main approves. Never edit an applied migration.

## Run / test

- Postgres: `pnpm compose:up` (host port **5433**, user `platform`, db `platform`), or set `DATABASE_URL`.
- `pnpm db:migrate` — applies `packages/db/migrations/*.sql` and `packages/events/migrations/*.sql` (outbox) in file-name order, as the owner role.
- `pnpm --filter @platform/db test` — Vitest; each test file creates and drops its own database via `createTestDatabase()`.
- `pnpm --filter @platform/db build | typecheck`
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/db` before finishing any task.

## Public API (`@platform/db`)

- `createTenantClient(pool, { organizationId, storeIds: string[], actorId? })` → `{ query, transaction, scope: 'store' }`.
  Sets `app.organization_id`, `app.scope='store'`, `app.store_ids`, `app.actor_id` transaction-locally (`set_config(..., true)`), so pooled connections never leak context.
- `createOrganizationClient(pool, { organizationId, actorId? })` → same shape, `scope: 'organization'` (HQ: all stores). Only after an organization-level permission check.
- `migrate(pool)`, `listMigrations()`, `createPool(url)`, `connectionStringFromEnv('owner' | 'app')`.
- `seed(pool)`, `SEED_IDS` — fixed uuids for brand-a/b/c, wh-eu/wh-us, one staff user per role.
- `@platform/db/testing` → `createTestDatabase()` returns `{ owner, app, drop }` pools (app = `platform_app` role, RLS enforced).

## Rules every consumer must follow

- Application processes connect as `platform_app` (`DATABASE_URL_APP`). The owner URL is for migrations and seeds only.
- Every query goes through a scoped client. Raw `pool.query` returns zero rows by design (no context).
- Table names `order` and `return` are reserved words: always write `"order"`, `"return"`.
- `audit_log` and `stock_movement` are append-only for the app role (no UPDATE/DELETE grants).
- Money is `*_minor bigint` + `currency char(3)`. Ids are uuid. See docs/domain.md.

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code (the `platform_app` password in 0001 is the docker-compose default; production rotates it via `ALTER ROLE` from Vault).
- Update README.md and CHANGELOG.md with every change.
