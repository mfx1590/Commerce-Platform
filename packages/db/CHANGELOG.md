# Changelog — @platform/db

## 0.1.0 — 2026-09-04

- Scaffold created by the main window (Phase 0).

## 0.1.0 — 2026-09-04 (Phase 0 step 4)

- Migrations 0001–0009: app schema + context functions, organization level, store registry, catalog/pricing, customers, cart/orders/payments/shipments/returns, inventory, ledger, RLS policies + grants.
- `createTenantClient` / `createOrganizationClient` (transaction-local context via set_config), `migrate`, `createPool`, `SEED_IDS`.
- `@platform/db/testing` → `createTestDatabase()`; test/rls.test.ts proves store isolation for the platform_app role (10 cases).
