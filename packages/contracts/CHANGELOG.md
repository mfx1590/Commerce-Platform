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

## 0.2.2 — 2026-09-08

- Store API 0.2.0: optional `metadata` on `Cart` and `Order`, and accepted by `createCart` and `updateCart` (CONTRACT CHANGE #100, additive). The database has carried these columns since migration 0006; the spec simply never exposed them, so #62's premise that it was already free-form was wrong. `completeCart` still has no request body — the last touch is PATCHed onto the cart before completing.
