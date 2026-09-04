# @platform/db

Schema, row-level security, tenant-scoped client, migration runner, seeds. Owner: main window.
See [CLAUDE.md](./CLAUDE.md) for the public API and rules; see [docs/domain.md](../../docs/domain.md) for every entity.

## Quick start

```bash
pnpm compose:up          # Postgres on localhost:5433
cp .env.example .env     # once, at the repo root
pnpm db:migrate
pnpm --filter @platform/db test
```

## How tenancy works (ADR 0001)

1. Every table has `organization_id`; store-level tables also have `store_id`. RLS is enabled and **forced** on all of them.
2. A request resolves a `TenantContext` (organization + the store ids the caller may act on) and opens a transaction
   through `createTenantClient`, which sets `app.*` settings transaction-locally.
3. Policies compare `organization_id` with `app.current_organization_id()` and `store_id` with `app.current_store_ids()`
   (or allow all stores when `app.scope = 'organization'`). No context → no rows.
4. The application role `platform_app` is `NOBYPASSRLS`. Migrations run as the owner role.

## Migrations

`migrations/NNNN_name.sql`, applied in name order, each in one transaction, recorded in `schema_migrations`.
The outbox table lives in `packages/events/migrations/0100_outbox.sql` and is applied by the same runner.
To change the schema: add a new file, never edit an applied one. Feature windows propose via PR (window 1) or a
`CONTRACT CHANGE:` issue.

## Tests

`test/rls.test.ts` creates a throwaway database, migrates it, seeds two stores, and proves with the `platform_app`
role that store A cannot read, filter, insert, or move store B rows; that organization scope sees all; that a
foreign organization and a context-less connection see nothing; and that per-store order numbers are sequential.
