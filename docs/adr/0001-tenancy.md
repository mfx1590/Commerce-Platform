# ADR 0001 — Tenancy: one database, `store_id` on every row, PostgreSQL row-level security

Status: accepted (Phase 0, 2026-09-04) · Owner: main window · Implemented in `packages/db`

## Context

One HQ operates N brands. Shared warehouses need one inventory truth, automatic accounting needs one order truth,
cross-brand BI needs one customer truth. Separate databases per brand would make all three a reconciliation problem
(plan section 1). At the same time a store admin must never see another store's data, and a bug in application code
must not be enough to leak it.

## Decision

1. **One PostgreSQL database, one schema, shared tables.** Every table carries `organization_id`; store-level tables
   also carry `store_id`. Warehouses, legal entities, staff users, customer identities and the ledger are
   organization-level; everything a shopper touches is store-level (docs/domain.md).
2. **Row-level security is the boundary, not the application.** RLS is enabled and **forced** on every table.
   Policies compare the row with transaction-local settings: `app.organization_id`, `app.scope`
   (`organization` | `store`), `app.store_ids` (csv). No settings → no rows, including for the table owner.
3. **Context is set per transaction by one client** (`createTenantClient` / `createOrganizationClient` in
   `@platform/db`) using `set_config(..., true)`, so a pooled connection cannot carry one tenant's context into the
   next request. Raw `pool.query` returns nothing by design.
4. **Two database roles.** `platform` (owner) runs migrations and seeds. `platform_app` (`NOBYPASSRLS`, no DDL) is
   the only role application processes use. `audit_log` and `stock_movement` are append-only for it.
5. **Store resolution happens at the edge of each request.** Store API: `X-Publishable-Key` → `store_api_key` →
   store + sales channel. Admin API: the staff JWT + OpenFGA (ADR 0002) → the set of stores the principal may act on
   → `app.store_ids`. HQ roles get `app.scope = 'organization'`.
6. **Multi-store principals** (a store admin of brands A and B) run with `app.store_ids = 'A,B'` and see both;
   this is the only way to see more than one store without an organization-level relation.

## Consequences

- A missing `WHERE store_id = …` in application code is a performance bug, not a security bug.
- Every migration that adds a table must call `app.apply_rls(table, kind)` (kinds: `organization`, `store`,
  `store_self`, `store_nullable`) in the same file; `packages/db` tests fail otherwise.
- Cross-store operations (stock transfers, HQ reports) run in organization scope after an organization-level
  permission check; they are the exception, never the default client.
- Medusa 2 (window 1) must route every query through the tenant client or through a connection that already has the
  context applied; Medusa's own repositories are wrapped, not bypassed.
- Per-store sequences (order `display_id`) are implemented with a counter column on `store`, updated in the insert
  trigger, so they stay correct under RLS.

## Alternatives rejected

- **Schema per store**: migrations × N, no cheap cross-store queries, still no protection against a wrong search_path.
- **Database per store**: the reconciliation problem the plan exists to avoid.
- **Application-only filtering**: one forgotten predicate leaks data; unauditable.
