# Memory 4 — Admin application
Window: 4 · Key: `admin` · Branch prefix: `admin/` · Model: Sonnet
Last updated: 2026-09-04 · Contracts: (not tagged yet) · Last commit: (none) · Status: not started

## Identity (does not change)
Owned paths (write):
- `apps/admin/**`
Reads:
- packages/contracts
- packages/auth-sdk
Never touches:
- apps/core internals
- packages/*

## Mission — Phase 1 (Isolated modules)
Single admin app with two permission-driven views. Shell: layout, nav rendering only allowed sections (HQ: Stores, Warehouse, Finance, BI, Roles, Onboarding; Store: Catalog, Orders, Customers, Promotions, Content, Settings), store switcher limited to allowedStores(user), auth hook, data-table and form primitives, working registry + catalog screens against the mock Admin API. Every screen handles 403 gracefully.

## Done
- (nothing yet)

## In progress
- (nothing yet)

## Next — Phase 1
- [ ] App skeleton, auth hook (Keycloak OIDC), session
- [ ] Permission-driven navigation + store switcher
- [ ] Data-table primitive (TanStack Table): sort, filter, paginate, bulk
- [ ] Form primitive (RHF + Zod) with server-error mapping
- [ ] Stores screen (HQ) and Catalog screens (Store view) against mock
- [ ] 403/empty/error states pattern
- [ ] Tests: nav renders per role fixture

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
Complete Store view against the real Admin API: catalog with variants/media, order detail with fulfil/refund/return, customers, promotions, content links, settings.
- [ ] Catalog editor
- [ ] Order detail + actions
- [ ] Customers
- [ ] Promotions
- [ ] Settings

### Phase 3 — Multi-store & HQ
HQ view: all-store dashboard, role management UI, finance section gated, onboarding wizard.
- [ ] HQ dashboard
- [ ] Roles UI
- [ ] Onboarding wizard
