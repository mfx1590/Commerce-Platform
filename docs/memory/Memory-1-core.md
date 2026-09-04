# Memory 1 — Core commerce

Window: 1 · Key: `core` · Branch prefix: `core/` · Model: Sonnet (strongest for migrations)
Last updated: 2026-09-04 · Contracts: (not tagged yet) · Last commit: (none) · Status: not started

## Identity (does not change)

Owned paths (write):

- `apps/core/**`
- `packages/db/** (via PR only, main window approves)`
  Reads:
- packages/contracts
- packages/events
- docs/domain.md
  Never touches:
- apps/admin
- apps/storefront*
- cms/
- infra/

## Mission — Phase 1 (Isolated modules)

Stand up Medusa 2 in apps/core: store & channel registry, catalog module, tenant-scoped data access through packages/db with RLS enforced on every query, outbox write on every state change, seed brands loading. Implement Store API and Admin API routes for registry and catalog exactly as in packages/contracts; everything else stays on the mock server.

## Done

- (nothing yet)

## In progress

- (nothing yet)

## Next — Phase 1

- [ ] Medusa 2 project in apps/core, boots against docker-compose Postgres/Redis
- [ ] Store & channel registry module + migrations (store, domain, locale, currency, sales_channel)
- [ ] Tenant context middleware: store_id from JWT/API key → set on DB session; RLS test store A cannot read store B
- [ ] Catalog module: product, variant, option, category, media ref; per-store
- [ ] Outbox table write inside the same transaction for every create/update/delete
- [ ] Store API routes: registry read, catalog list/detail/search stub, matching contracts
- [ ] Admin API routes: registry CRUD, catalog CRUD, matching contracts
- [ ] Seed script: 3 brands × 200 products, 2 warehouses
- [ ] Module READMEs + CLAUDE.md per module; unit + integration tests green

## Decisions made (with reasons)

- (none yet)

## Blocked / waiting

- (none)

## Gotchas learned

- (none yet)

## How to run & test this package

- (fill in after first setup: exact commands)

## Later phases (do not start until Memory-main says so)

### Phase 2 — Commerce complete, brand 1 live

Full order lifecycle (place, edit, cancel, split shipment, return, exchange), stock locations with reservations and backorders, as Medusa modules/workflows with compensation on failure, every transition emitting its event through the outbox.

- [ ] Cart module against contracts
- [ ] Order state machine + workflows with compensation
- [ ] Inventory levels per warehouse, reservations, backorders
- [ ] Returns and exchanges
- [ ] Events for every transition; replay test

### Phase 3 — Multi-store & HQ

Multi-store at scale: N stores with separate domains/settings, and the brand onboarding workflow (store, domain, CMS space, PSP account, search index, theme repo, default roles).

- [ ] Store settings per domain/locale/currency matrix
- [ ] Onboarding workflow module (idempotent steps)
- [ ] Cross-store customer identity link table
