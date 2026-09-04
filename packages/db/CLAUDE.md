# @platform/db

## Purpose

Plain SQL migrations for every core entity (all rows carry store_id or organization_id), PostgreSQL row-level-security policies, the migration runner, the tenant-scoped client, and the seed loader. Tests prove that a session for store A cannot read rows of store B.

## Owner

main window. Window 1 (core) may propose migrations via PR; main approves.

## Run / test

- `pnpm --filter @platform/db build` — compile to dist/
- `pnpm --filter @platform/db typecheck`
- `pnpm --filter @platform/db test` — Vitest (tests live in test/)
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/db` before finishing any task.

## Public API

- `createTenantClient(pool, { storeId, organizationId, actorId })` → `{ query, transaction }` that sets `app.store_id` etc. per transaction
- `createOrganizationClient(pool, { organizationId, actorId })` — HQ scope (all stores of the org)
- `migrate(pool)`, `seed(pool)` — used by `pnpm db:migrate`, `pnpm db:seed`
- SQL lives in `migrations/NNNN_name.sql`; never edit an applied migration, add a new one

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs. Every DB access through `@platform/db` tenant client.
- Update README.md and CHANGELOG.md with every change.
