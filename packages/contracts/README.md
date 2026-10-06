# @platform/contracts

OpenAPI contracts for the Store API and Admin API, generated types, and Prism mocks. Owner: main window.
See [CLAUDE.md](./CLAUDE.md) for the public API and frozen conventions.

| Spec                     | `info.version` | Operations | Areas                                                                                                  |
| ------------------------ | -------------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| `openapi/store-api.yaml` | 0.5.4          | 22         | store, catalog, cart, checkout, orders, customers                                                      |
| `openapi/admin-api.yaml` | 0.4.9          | 113        | registry, catalog, pricing, orders, inventory, fulfillment, customers, roles, audit, marketing, search |

`CONTRACTS_VERSION` is `0.4.11` (tag contracts-v0.4.11); it ships with events 0.3.1 and db 0.3.2. 0.4.4 froze the `SegmentRules` grammar (#239); 0.4.5 added
abandoned-cart recovery (#244/#245); 0.4.6 the pick/pack examples (#261); 0.4.7 the typed review shape (#270),
the customers additions (#264) and the registry settings operations (#279); 0.4.8 makes `Store.currencies` / `Store.locales`
required (#279), documents the customer self-service statuses (#303) and lets `createCart` / `completeCart` take an optional
customer token (#310); 0.4.9 adds the address default flags to `addMyAddress` and documents the `400` that
`updateMe` and `listMyOrders` already answer (#303 PR B); 0.4.10 documents the `409` `createCart` answers when a
customer token's email belongs to another account, and drops the misleading `default: false` on the two
`addMyAddress` flags; 0.4.11 (Admin API 0.4.9, #354) adds `capturePayment` and `buyShipmentLabel` with the shared 422
`Unprocessable` response and documents the order status lifecycle decided on #350 on the `Order` schema, and Store
API 0.5.4 adds the optional `Store.payment.methods` (`card` | `invoice`). The marketing area (37 operations, 15 components) is specified in
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
