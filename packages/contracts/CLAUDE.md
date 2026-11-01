# @platform/contracts

## Purpose

The frozen API contract (tag contracts-v0.1): OpenAPI 3.1 for the **Store API** (`openapi/store-api.yaml`, what
storefronts call) the **Admin API** (`openapi/admin-api.yaml`, what the admin app calls) and the **Accounting API**
(`openapi/accounting.yaml`, the accounting service's Finance reads, #572), generated TypeScript
types, shared constants (headers, error codes, relations), and a Prism mock server. Feature windows build against the
mock; the Integrator replaces mocks with the real core.

## Owner

main window only. Feature windows: read-only. Any change goes through an issue titled `CONTRACT CHANGE: <what>`
with the exact YAML diff; the Integrator applies accepted changes, bumps `info.version`, regenerates, and re-tags.

## Run / test

- `pnpm mock` (root) — Store API mock on http://localhost:4010, Admin API mock on http://localhost:4011, Accounting API mock on http://localhost:4013 (`MOCK_STORE_PORT`, `MOCK_ADMIN_PORT`, `MOCK_ACCOUNTING_PORT` to override). Send `X-Publishable-Key: anything` / `Authorization: Bearer anything`; the mock only checks presence. Prism validates requests (400 on bad bodies) and responses.
- `pnpm --filter @platform/contracts generate` — regenerates `src/generated/{store,admin,accounting}.ts` (openapi-typescript); committed, CI checks they are current.
- `pnpm --filter @platform/contracts test` — static spec checks (every admin operation has `x-permission` and documents 401/403, money is integer, eleven areas covered incl. marketing and search, the marketing, merchandising, media and promotion permission matrices, the `ProductFeed` / `allOf` sweep, the Store API `currency` query).
- `pnpm --filter @platform/contracts test:contract` — boots both mocks on :4110/:4111 and walks the storefront journey + admin surfaces + the marketing flow (campaign → launch → attribution report, feed publish, review moderation) + merchandising (create rule → publish → list) + 0.4.1 (media upload params → add → move → delete, promotion `buy_x_get_y` create → patch, feed in `error`) + `Prefer: code=403` refusals; fails if an example violates its schema.
- `pnpm --filter @platform/contracts build | typecheck`

## Public API

- `import type { StorePaths, StoreComponents, StoreOperations } from '@platform/contracts'` (or `@platform/contracts/store` → `paths`, `components`, `operations`)
- `import type { AdminPaths, AdminComponents, AdminOperations } from '@platform/contracts'` (or `@platform/contracts/admin`)
- `import type { AccountingPaths, AccountingComponents, AccountingOperations } from '@platform/contracts'` (or `@platform/contracts/accounting`)
- `HEADERS` (`X-Publishable-Key`, `Idempotency-Key`, `X-Request-Id`), `MOCK_URLS`, `ERROR_CODES` / `ErrorCode`, `RELATIONS` / `Relation`, `CONTRACTS_VERSION`
- Example: `type Product = StoreComponents['schemas']['Product']`; `type ListOrders = AdminOperations['listOrders']`

## Conventions frozen in the spec

- Store API: every request carries `X-Publishable-Key`; customer routes add a Bearer JWT (Keycloak customers realm). Admin API: Bearer JWT (staff realm).
- Admin store-scoped resources: `/admin/stores/{storeId}/...`; org-level: `/admin/...`. Each operation's `x-permission: { relation, object }` is the OpenFGA check the server performs (`viewer` = any relation on the object).
- Marketing (0.3.0, docs/marketing-scope.md): `/admin/stores/{storeId}/marketing/…` reads `store_staff`, writes/launch/publish/moderate `store_admin`, reports `viewer`; `/admin/marketing/dashboard` `analyst` and `/admin/marketing/segment-templates` `viewer` reads / `owner` writes on `organization:hq`. Store API `listProducts`/`getProduct` take an optional `currency` query.
- Merchandising (0.4.0, CONTRACT CHANGE #162): `/admin/stores/{storeId}/merchandising/rules[/{ruleId}]` + `…/merchandising/publish`, tag `search`; reads `store_staff`, writes and publish `store_admin` on `store:{storeId}`; one rule per store + scope (`category` | `query`), scope immutable, list fields replace on PATCH. Every admin operation documents `401` and `403` (#180); a new operation must too (spec test).
- 0.4.1 (CONTRACT CHANGE #168, #189, #194; 100 operations): product media `POST …/media/upload-params` (`store_staff`, 409 without credentials) + `…/products/{productId}/media[/{mediaId}]` (`viewer` read / `store_staff` write, `alt` required, positions server-owned and contiguous); promotions `GET|PATCH …/promotions/{promotionId}` (`viewer` / `store_admin`, `code` and `type` immutable), `type` += `buy_x_get_y`, `stackable` / `exclusive`, `PromotionRules.buy_quantity|get_quantity|get_discount_bp` (stored in the `rules` jsonb; db migration 0150); `ProductFeed` spelled out so `status: error` validates. Never compose `X` as `allOf[XInput, …]` and then restate a property of `XInput` (the spec test refuses it).
- 0.4.7 (CONTRACT CHANGE #270 + #264 + #279; 111 admin / 22 store operations): Store API 0.5.0 review shape — `Review`/`ReviewSummary`/`ReviewPage`, `Product.review_summary` (omitted = no feature; average null when count 0, never 0; author = display name chosen at review time, never account-derived), `GET /store/products/{handle}/reviews`; Admin API 0.4.7 — customers `listCustomerAddresses` (support) / `exportCustomer` (202, store_admin) / `listCustomerGroups` (viewer), registry `revokeApiKey` (409 `last_live_key`) / `updateDomain` (owner, primary move) / `Store.currencies`+`locales` with StoreInput replace-the-set semantics. Core registry work = window 1 (#279 bundle with #265/#284).
- 0.4.5 (CONTRACT CHANGE #244 + #245; 106 admin / 21 store operations): abandoned-cart recovery — `GET /admin/stores/{storeId}/marketing/reports/abandoned-carts` (`viewer`, `AbandonedCartReport`: abandoned/redeemed/recovered + rate, cancelled orders excluded from recovered figures) and Store API 0.4.0 `POST /store/cart-recovery/{token}` (`recoverCart`: single-use, one 404 for unknown/expired/redeemed, 409 for a completed cart, POST so prefetchers cannot burn the token). db 0.3.2 migration 0170 (`cart_recovery`, `marketing_cursor`).
- 0.4.4 (CONTRACT CHANGE #239; 105 operations): `SegmentRules` frozen — `{ v: 1, all: [{ any: [predicate…] }] }`, AND of ORs over a closed `SegmentPredicate` set (six branches, all `additionalProperties: false`), 400 naming the offending path on anything outside it; `tags` reads customer.metadata.tags, `country` matches the default shipping address only. The module publishes the same grammar as `SEGMENT_RULES_SCHEMA`.
- 0.4.3 (CONTRACT CHANGE #225 + #228; 105 operations): shipment pick/pack — `POST /admin/shipments/{shipmentId}/pick|pack` + `GET /admin/stores/{storeId}/pick-lists` (`operations` on `organization:hq`), `Shipment.status` += `picking`/`packed` (db migration 0160, events 0.3.0 `fulfillment.*`); Store API 0.3.1 — `price_changed` machine code on completeCart's 409 (nothing placed, cart re-priced, same Idempotency-Key retries).
- 0.4.2 (CONTRACT CHANGE #172; 102 operations): order line-item edits before fulfilment — `PATCH /admin/stores/{storeId}/orders/{orderId}/line-items/{lineItemId}` (`updateOrderLineItem`, lower the quantity; totals recomputed, difference recorded in `order.metadata.edits`, no money moved) and `DELETE` (`cancelOrderLineItem`; the last line cannot be cancelled — cancel the order). Both `store_admin` on the store. Ships with db 0.3.0 (migration 0140 `webhook_event`, #187).
- 0.4.11 (CONTRACT CHANGE #354 + #350; Admin API 0.4.9, 113 admin / 22 store operations): `capturePayment` (`store_admin`, optional partial `amount_minor`, 409 not authorized / over the authorisation, 422 manual provider) and `buyShipmentLabel` (`operations` on `organization:hq`, 409 unless `packed`, 422 manual carrier); shared `Unprocessable` response, machine code `provider_unsupported`; the order lifecycle (`pending → confirmed → processing → completed`, `cancelled` explicit) is documented on `Order`. Events 0.3.1 `shipment.label_created`. Store API 0.5.4: optional `Store.payment.methods` (`card` | `invoice`), optional until the core returns it.
- 0.4.28 (CONTRACT CHANGE #572; Accounting API 0.1.0, 7 operations): `openapi/accounting.yaml`, GET only, every operation `finance` on `organization:hq` with 401 / 403, 404 on a path id, shared `BadRequest` 400 on query params; `*_minor` integers plus `currency`, never summed across currencies; producer apps/accounting.
- 0.4.29 (CONTRACT CHANGE #607; Store API 0.5.9, 31 store operations; db 0.3.19): `GET /store/recommendations` (`listProductRecommendations`, tag `catalog`) + `RecommendationList` reusing `ProductSummary`; `kind` `bought_together` | `popular`, `limit` max 24, the response `kind` reports the popular fallback; migration 0204 `product_recommendation` (RLS kind `store`, no UPDATE grant, composite keys to `product (store_id, id)`).
- 0.4.31 (CONTRACT CHANGE #664; Admin API 0.4.26, 138 admin operations): `draftProductCopy` (`POST /admin/stores/{storeId}/products/{productId}/copy-drafts`, `store_staff` on the store) returns `ProductCopyDraft`, never written to the product; the error codes `ai_disabled`, `ai_budget_exceeded`, `ai_rate_limited` (with `Retry-After`), `ai_refused`, `ai_unavailable` and `ai_invalid_draft`; the `MetricQuery.filters` arrays have `minItems: 1`.
- 0.4.30 (CONTRACT CHANGE #603; Admin API 0.4.25, 137 admin operations): `listMetrics` (`GET /admin/metrics`) + `queryMetrics` (`POST /admin/metrics/query`), tag `reports`, `viewer` on `store:*`, always scoped on the server to the caller's stores (outside the scope is a 403, never empty rows; finance metrics also need `finance` on `organization:hq`); closed enums only, no SQL input; live metrics `live_orders` / `live_placed_minor`; `text/csv` on `Accept: text/csv`; shared `ServiceUnavailable` 503 and `unavailable` in `ERROR_CODES`.
- Money `{ amount_minor, currency }`; ids uuid; timestamps RFC-3339; lists `{ page, limit, total, items }`; errors `{ code, message, details }`.
- Mutations that create money movements (`completeCart`, `createRefund`) require `Idempotency-Key`.
- Seed ids in examples match `SEED_IDS` in `@platform/db` (brand-a store = `…0031`).

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs.
- Update README.md and CHANGELOG.md with every change.
