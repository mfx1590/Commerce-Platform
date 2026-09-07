# Changelog — @platform/contracts

## 0.1.0 — 2026-09-04

- Scaffold created by the main window (Phase 0).

## 0.1.0 — 2026-09-04 (Phase 0 step 6)

- `openapi/store-api.yaml` (20 operations: store, catalog, cart, checkout, orders, customers) and `openapi/admin-api.yaml` (46 operations across registry, catalog, pricing, orders, inventory, fulfillment, customers, roles, audit; every operation carries `x-permission`).
- Generated types via openapi-typescript (`src/generated/*`, committed); `HEADERS`, `MOCK_URLS`, `ERROR_CODES`, `RELATIONS`.
- `pnpm mock` → Prism on :4010 (store) and :4011 (admin); static spec tests + Prism contract tests (`test:contract`).

## 0.2.0 — 2026-09-05

- Admin API: optional `sort` (per-operation enum) + `order` (asc|desc, default desc) on listStores, listProducts, listOrders, listCustomers, listPromotions, listUsers, listInventoryLevels, listAuditLog (CONTRACT CHANGE #56, additive). Defaults reproduce 0.1.0 ordering.

## 0.2.1 — 2026-09-07

- Admin API: listCustomers and getCustomer require `support` on the store instead of `viewer` (CONTRACT CHANGE #77): analysts, finance and operations no longer read customer PII; store_admin/support/owner keep it.
