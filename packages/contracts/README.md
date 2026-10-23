# @platform/contracts

OpenAPI contracts for the Store API and Admin API, generated types, and Prism mocks. Owner: main window.
See [CLAUDE.md](./CLAUDE.md) for the public API and frozen conventions.

| Spec                     | `info.version` | Operations | Areas                                                                                                           |
| ------------------------ | -------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| `openapi/store-api.yaml` | 0.5.8          | 30         | store, catalog, cart, checkout, orders, customers                                                               |
| `openapi/admin-api.yaml` | 0.4.24         | 135        | registry, catalog, pricing, orders, inventory, fulfillment, customers, roles, audit, marketing, search, reports |

`CONTRACTS_VERSION` is `0.4.27`; it ships with events 0.3.6 and db 0.3.17. 0.4.27 (Admin API 0.4.24, #569) adds the optional `customer_id` filter to `listOrders`. 0.4.4 froze the `SegmentRules` grammar (#239); 0.4.5 added
abandoned-cart recovery (#244/#245); 0.4.6 the pick/pack examples (#261); 0.4.7 the typed review shape (#270),
the customers additions (#264) and the registry settings operations (#279); 0.4.8 makes `Store.currencies` / `Store.locales`
required (#279), documents the customer self-service statuses (#303) and lets `createCart` / `completeCart` take an optional
customer token (#310); 0.4.9 adds the address default flags to `addMyAddress` and documents the `400` that
`updateMe` and `listMyOrders` already answer (#303 PR B); 0.4.10 documents the `409` `createCart` answers when a
customer token's email belongs to another account, and drops the misleading `default: false` on the two
`addMyAddress` flags; 0.4.11 (Admin API 0.4.9, #354) adds `capturePayment` and `buyShipmentLabel` with the shared 422
`Unprocessable` response and documents the order status lifecycle decided on #350 on the `Order` schema, and Store
API 0.5.4 adds the optional `Store.payment.methods` (`card` | `invoice`); 0.4.12 (Admin API 0.4.10) adds
`provider_unsupported` to `ERROR_CODES` (the core maps it to 422) and documents that a carrier outage on `buyShipmentLabel` is a
retryable 502, not a 422; 0.4.13 (Admin API 0.4.11, #417) adds `onboardStore` (one-transaction brand onboarding, idempotent by
`code`, the publishable key shown once) and `activateStore` (409 `details.missing[]`), and the 422 `validation_error` on a wrong-shaped
`store.settings` value (`onboardStore`, `updateStore`); 0.4.14 (Admin API 0.4.12, #423 + events 0.3.2 #425) adds `inviteUser`'s
documented 400, `createStore`'s 422 `InvalidSettings` (the settings shape check fires there too) and the
`customer.export_requested` topic that `exportCustomer` promises; 0.4.15 (Admin API 0.4.13, #453 + events 0.3.3 + db 0.3.5,
stock pool step 2) adds `listStockItems` and `mapVariantToStockItem` (organization scope; the mapping writes
`stock_item.mapped`), the `StockItem` / `StockLevel` schemas and a required `InventoryLevel.stock_item_id` — the row
carries the pool's numbers, keyed by (`variant_id`, `warehouse_id`) — with `stock.moved` v2; 0.4.16 (Admin API 0.4.14,
#458 + db 0.3.6, cycle counts) adds `listCycleCounts`, `createCycleCount` and `reconcileCycleCount` (`operations` on
`organization:hq`) with the `CycleCount` schema — a count changes no stock until it is reconciled, a discrepancy above
the tolerance is a 200 with status `flagged`, and a superseded count is a 409 `conflict` with `details.reason` (no new
error code); 0.4.17 (Admin API 0.4.15 + Store API 0.5.5, #466 + events 0.3.4 + db 0.3.7) adds
`voided` to the order's `payment_status` (authorized → voided on cancel; terminal; additive); 0.4.18 (Admin API
0.4.16, #469) adds three HQ reads — `listStockItemMovements` and `listStockItemReservations` (`viewer` on
`organization:hq`) with `StockMovement` / `StockReservation`, and `previewCycleCountReconcile` (`operations` on
`organization:hq`), a safe GET that writes nothing and takes no lock, with `CycleCountPreview`; 0.4.19 (Admin API
0.4.17, #475) adds the required, read-only `InventoryLevel.warehouse_code` (the warehouse row's `code`), so a
store-scoped caller names the warehouse without `listWarehouses`; no permission changes; 0.4.20 (Store API 0.5.6,
#482 + events 0.3.5) adds customer self-service — `updateMyAddress` (partial PATCH), `deleteMyAddress` (200 with
the remaining `{ items }`), `requestMyExport` (202, `customer.export_requested` v2) and `deleteMe` (202, erasure); 0.4.21 (Store API 0.5.7 +
Admin API 0.4.18, #489 + db 0.3.9) adds the consent ledger — `getMyConsents` / `putMyConsents` (`CustomerConsent`,
`granted` `null` = never asked, `false` = refused; `policy_version` required on the answer) and
`listCustomerConsents` (`support` on the store, newest first, 404 for an erased customer); 0.4.22 (Admin API 0.4.19,
#493) adds the reporting v1 reads under `reports` — `getStoreSalesReport` / `getStoreStockReport` (`viewer` on the
store), `getHqSalesReport` (`analyst` on `organization:hq`) and `getHqFinanceReport` (`finance` on `organization:hq`,
fees unreconciled), amounts per currency, never summed across currencies; 0.4.23 (Store API 0.5.8 + Admin API 0.4.20,
#498 + events 0.3.6 + db 0.3.10) adds the GDPR export delivery — the error code `expired` with the shared 410 `Gone`,
`listMyExports` / `getMyExport` (customer token; pending 404, expired 410) and `listCustomerExports` /
`getCustomerExport` (`store_admin` on the store), `CustomerExportSummary` in both specs, and the #496 follow-up 400
on `listCustomerConsents`; 0.4.24 (Admin API 0.4.21, #504 + db 0.3.11) adds
`getCustomerIdentity` (`support` on `organization:hq`; a store-scoped principal gets 403, an unknown identity 404),
the per-brand customer rows one person's identity links, ids only; 0.4.26 (Admin API 0.4.23, #522 + db 0.3.15)
adds the store tax rates — `listTaxRates` (`viewer` on the store), `createTaxRate` / `updateTaxRate` /
`deleteTaxRate` (`store_admin`; a duplicate (country, region, category) is a 409 from the database index), `TaxRate`,
and the `tax_rates` activation prerequisite with `details.missing_tax_countries`. The marketing area (37 operations, 15 components) is specified in
[docs/marketing-scope.md](../../docs/marketing-scope.md); the search area (6 merchandising operations, 5 components) in
CONTRACT CHANGE #162; 0.4.1 adds product media (5 operations, 5 components, #168), `getPromotion` / `updatePromotion`
with `buy_x_get_y` and `stackable` / `exclusive` (#189) and a spelled-out `ProductFeed` (#194); 0.4.2 adds order
line-item edits — `updateOrderLineItem` / `cancelOrderLineItem` before fulfilment (#172); 0.4.3 adds the shipment
pick/pack lifecycle — `pickShipment` / `packShipment` / `listPickLists` with `picking` / `packed` status values
(#225) and the Store API `price_changed` error code on completeCart (#228). Every admin operation documents `401`
and `403` (#180), so `Prefer: code=403` works on the mock.

## Start the mocks

```bash
pnpm mock
```

| Mock      | URL                   | Auth header                  |
| --------- | --------------------- | ---------------------------- |
| Store API | http://localhost:4010 | `X-Publishable-Key: pk_test` |
| Admin API | http://localhost:4011 | `Authorization: Bearer test` |

The mock returns the documented examples (brand-a store, product `classic-tee`, order `#1000`, customer Jane), and
answers 400 on request bodies that violate the schema.

## Use the types

```ts
import type { StoreComponents, AdminOperations } from '@platform/contracts';
type Cart = StoreComponents['schemas']['Cart'];
type ListOrdersQuery = AdminOperations['listOrders']['parameters']['query'];
```

## Change the contract

Feature windows never edit `openapi/*.yaml`. File `CONTRACT CHANGE: <what>` with the exact diff and keep building
against a local override of the mock (Prism accepts a second spec file if you need a stub). The Integrator applies
changes at the phase boundary, bumps `info.version` and `CONTRACTS_VERSION`, regenerates, and tags `contracts-vX.Y`.
