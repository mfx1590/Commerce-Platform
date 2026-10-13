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
Since 0.2.0 it also covers the marketing tables (0120): campaign and attribution rows stay per store, and segment
templates (`store_id NULL`) are visible only in organization scope. Since 0.2.1 it covers `merchandising_rule` (0130):
rules stay per store and one rule per store + scope is enforced. Since 0.2.2 it covers migration 0150: `promotion.type`
accepts `buy_x_get_y` and still refuses unknown types. Since 0.3.3 it covers `notification_delivery` (0180): rows
stay per store, organization scope sees every store, a re-delivered `event_id` conflicts, and the table has no
recipient column. Since 0.3.4 / 0.3.5 it covers the stock pool (below): the mapping guard, the pool row, the
ledger's attribution rule and per-store reservations on a shared item.

## Stock pool (0190 + 0191, db 0.3.4 and 0.3.5)

`stock_item` is organization-level: what physically lies on a shelf, shared by the brands that map it. A store's
variant points at one item through `product_variant.stock_item_id` (NOT NULL since 0191). Whoever maps a variant
gains that item's pool rows, so the mapping is guarded in the database: only organization scope may insert a variant
that is already mapped or change a mapping (trigger `guard_variant_stock_item`, 42501 otherwise, a missing scope
included). Row security for the pool uses the kinds `pool_self`, `pool` and `pool_ledger` (see the migration): a
store-scoped session reaches a pool row only when one of its own stores maps the item, and a ledger row only when it
is also attributed to one of its stores; organization scope sees all. The backfill runs as the migration role, which
must bypass row security (it does locally and in CI), and maps every existing variant 1:1.

Step 2 (0191, db 0.3.5) rekeys the stock tables onto the item:

- `inventory_level` is one row per (`stock_item_id`, `warehouse_id`) — the pool. It has no `store_id` and no
  `variant_id`; RLS kind `pool`, so every store that maps the item sees the same row, its `reserved` total included.
- `stock_movement` is the pool's ledger: `stock_item_id` is required, `store_id` and `variant_id` are NULL together
  for a movement no store caused (receipt, transfer, cycle count). RLS kind `pool_ledger`: a store session reads and
  writes only movements of an item it maps that are attributed to one of its own stores. Still append-only.
- `reservation` gains `stock_item_id` and `allocation_rule` and stays per store (RLS kind `store`): a brand never sees
  another brand's reservations, only their sum on the pool row.
- A variant inserted without an item gets its own from trigger `variant_stock_item` (same naming rule as the
  backfill), so the catalog keeps creating variants in store scope. Known and accepted within one organization: an
  item sku prefixed with the store code tells a store admin that another brand already holds that sku.

The seed has one shared item, `SEED_IDS.sharedStock`: brand A's and brand B's first variants map it and it is
stocked in `wh-eu`. `topUpStock` writes store-less movements.
