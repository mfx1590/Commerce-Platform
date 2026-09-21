# @platform/contracts

## Purpose

The frozen API contract (tag contracts-v0.1): OpenAPI 3.1 for the **Store API** (`openapi/store-api.yaml`, what
storefronts call) and the **Admin API** (`openapi/admin-api.yaml`, what the admin app calls), generated TypeScript
types, shared constants (headers, error codes, relations), and a Prism mock server. Feature windows build against the
mock; the Integrator replaces mocks with the real core.

## Owner

main window only. Feature windows: read-only. Any change goes through an issue titled `CONTRACT CHANGE: <what>`
with the exact YAML diff; the Integrator applies accepted changes, bumps `info.version`, regenerates, and re-tags.

## Run / test

- `pnpm mock` (root) — Store API mock on http://localhost:4010, Admin API mock on http://localhost:4011 (`MOCK_STORE_PORT`, `MOCK_ADMIN_PORT` to override). Send `X-Publishable-Key: anything` / `Authorization: Bearer anything`; the mock only checks presence. Prism validates requests (400 on bad bodies) and responses.
- `pnpm --filter @platform/contracts generate` — regenerates `src/generated/{store,admin}.ts` (openapi-typescript); committed, CI checks they are current.
- `pnpm --filter @platform/contracts test` — static spec checks (every admin operation has `x-permission` and documents 401/403, money is integer, eleven areas covered incl. marketing and search, the marketing, merchandising, media and promotion permission matrices, the `ProductFeed` / `allOf` sweep, the Store API `currency` query).
- `pnpm --filter @platform/contracts test:contract` — boots both mocks on :4110/:4111 and walks the storefront journey + admin surfaces + the marketing flow (campaign → launch → attribution report, feed publish, review moderation) + merchandising (create rule → publish → list) + 0.4.1 (media upload params → add → move → delete, promotion `buy_x_get_y` create → patch, feed in `error`) + `Prefer: code=403` refusals; fails if an example violates its schema.
- `pnpm --filter @platform/contracts build | typecheck`

## Public API

- `import type { StorePaths, StoreComponents, StoreOperations } from '@platform/contracts'` (or `@platform/contracts/store` → `paths`, `components`, `operations`)
- `import type { AdminPaths, AdminComponents, AdminOperations } from '@platform/contracts'` (or `@platform/contracts/admin`)
- `HEADERS` (`X-Publishable-Key`, `Idempotency-Key`, `X-Request-Id`), `MOCK_URLS`, `ERROR_CODES` / `ErrorCode`, `RELATIONS` / `Relation`, `CONTRACTS_VERSION`
- Example: `type Product = StoreComponents['schemas']['Product']`; `type ListOrders = AdminOperations['listOrders']`

## Conventions frozen in the spec

- Store API: every request carries `X-Publishable-Key`; customer routes add a Bearer JWT (Keycloak customers realm). Admin API: Bearer JWT (staff realm).
- Admin store-scoped resources: `/admin/stores/{storeId}/...`; org-level: `/admin/...`. Each operation's `x-permission: { relation, object }` is the OpenFGA check the server performs (`viewer` = any relation on the object).
- Marketing (0.3.0, docs/marketing-scope.md): `/admin/stores/{storeId}/marketing/…` reads `store_staff`, writes/launch/publish/moderate `store_admin`, reports `viewer`; `/admin/marketing/dashboard` `analyst` and `/admin/marketing/segment-templates` `viewer` reads / `owner` writes on `organization:hq`. Store API `listProducts`/`getProduct` take an optional `currency` query.
- Merchandising (0.4.0, CONTRACT CHANGE #162): `/admin/stores/{storeId}/merchandising/rules[/{ruleId}]` + `…/merchandising/publish`, tag `search`; reads `store_staff`, writes and publish `store_admin` on `store:{storeId}`; one rule per store + scope (`category` | `query`), scope immutable, list fields replace on PATCH. Every admin operation documents `401` and `403` (#180); a new operation must too (spec test).
- 0.4.1 (CONTRACT CHANGE #168, #189, #194; 100 operations): product media `POST …/media/upload-params` (`store_staff`, 409 without credentials) + `…/products/{productId}/media[/{mediaId}]` (`viewer` read / `store_staff` write, `alt` required, positions server-owned and contiguous); promotions `GET|PATCH …/promotions/{promotionId}` (`viewer` / `store_admin`, `code` and `type` immutable), `type` += `buy_x_get_y`, `stackable` / `exclusive`, `PromotionRules.buy_quantity|get_quantity|get_discount_bp` (stored in the `rules` jsonb; db migration 0150); `ProductFeed` spelled out so `status: error` validates. Never compose `X` as `allOf[XInput, …]` and then restate a property of `XInput` (the spec test refuses it).
- 0.4.5 (CONTRACT CHANGE #244 + #245; 106 admin / 21 store operations): abandoned-cart recovery — `GET /admin/stores/{storeId}/marketing/reports/abandoned-carts` (`viewer`, `AbandonedCartReport`: abandoned/redeemed/recovered + rate, cancelled orders excluded from recovered figures) and Store API 0.4.0 `POST /store/cart-recovery/{token}` (`recoverCart`: single-use, one 404 for unknown/expired/redeemed, 409 for a completed cart, POST so prefetchers cannot burn the token). db 0.3.2 migration 0170 (`cart_recovery`, `marketing_cursor`).
- 0.4.4 (CONTRACT CHANGE #239; 105 operations): `SegmentRules` frozen — `{ v: 1, all: [{ any: [predicate…] }] }`, AND of ORs over a closed `SegmentPredicate` set (six branches, all `additionalProperties: false`), 400 naming the offending path on anything outside it; `tags` reads customer.metadata.tags, `country` matches the default shipping address only. The module publishes the same grammar as `SEGMENT_RULES_SCHEMA`.
- 0.4.3 (CONTRACT CHANGE #225 + #228; 105 operations): shipment pick/pack — `POST /admin/shipments/{shipmentId}/pick|pack` + `GET /admin/stores/{storeId}/pick-lists` (`operations` on `organization:hq`), `Shipment.status` += `picking`/`packed` (db migration 0160, events 0.3.0 `fulfillment.*`); Store API 0.3.1 — `price_changed` machine code on completeCart's 409 (nothing placed, cart re-priced, same Idempotency-Key retries).
- 0.4.2 (CONTRACT CHANGE #172; 102 operations): order line-item edits before fulfilment — `PATCH /admin/stores/{storeId}/orders/{orderId}/line-items/{lineItemId}` (`updateOrderLineItem`, lower the quantity; totals recomputed, difference recorded in `order.metadata.edits`, no money moved) and `DELETE` (`cancelOrderLineItem`; the last line cannot be cancelled — cancel the order). Both `store_admin` on the store. Ships with db 0.3.0 (migration 0140 `webhook_event`, #187).
- Money `{ amount_minor, currency }`; ids uuid; timestamps RFC-3339; lists `{ page, limit, total, items }`; errors `{ code, message, details }`.
- Mutations that create money movements (`completeCart`, `createRefund`) require `Idempotency-Key`.
- Seed ids in examples match `SEED_IDS` in `@platform/db` (brand-a store = `…0031`).

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs.
- Update README.md and CHANGELOG.md with every change.
