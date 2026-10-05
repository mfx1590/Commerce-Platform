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

## 0.3.0 — 2026-09-08 (Integration 1, marketing; tag contracts-v0.3)

- Admin API 0.3.0 (87 operations, was 50): the `marketing` area from docs/marketing-scope.md, additive. Store-scoped under `/admin/stores/{storeId}/marketing/`: campaigns CRUD + `launch`/`end`, segments CRUD + `preview` (`{count}`) + `materialize` (202), feeds CRUD + `publish` + paged `items`, referral-programs CRUD, referrals list, reviews list + `moderate` (`{status: published|rejected, reason?}`), `reports/attribution` (`from`/`to`/`touch=first|last`, rows by source/medium/campaign with `orders_count` and `revenue`), `reports/promotions` (per code: `uses`, `discount_given`, `revenue`). Organization-level: `GET /admin/marketing/dashboard` (per-store rows) and `/admin/marketing/segment-templates` CRUD.
- Permissions: reads `store_staff`, writes (incl. launch, publish, moderate, materialize) `store_admin`, both on `store:{storeId}`; `previewSegment` writes nothing and is `store_staff`. Reports are `viewer` on `store:{storeId}` — the spec's one way to say "any relation", so analysts read them alongside store staff (an `analyst`-only gate would have locked store staff out of their own reports). Dashboard `analyst` on `organization:hq`; template reads `viewer`, template writes `owner` on `organization:hq`.
- New components: `Campaign`/`CampaignInput`, `Segment`/`SegmentInput`/`SegmentRules` (loose object, `additionalProperties: true`; grammar frozen by window 17 in Phase 2.3), `ProductFeed`/`ProductFeedInput`, `FeedItem`, `ReferralProgram`/`ReferralProgramInput`, `Referral`, `Review`, `AttributionReport`, `PromotionReport`, `MarketingDashboard`; examples use `SEED_IDS` (store `…0031`, promotion `…0101`, product `…0201`, order line item `…0901`, customer `…0a01`) and `7000…07NN` ids for marketing rows.
- Store API 0.3.0: optional `currency` query (ISO-4217, `^[A-Z]{3}$`) on `listProducts` and `getProduct` — prices in that currency; must be one of the store's currencies (`GET /store` lists them); 400 `validation_error` otherwise; default = the store's default currency. Both operations now document `400`.
- `CONTRACTS_VERSION = '0.3.0'`; types regenerated; `test:contract` walks create campaign → launch → attribution report, feed create → publish → items, review moderation, segment preview, dashboard/templates, and the Store API currency query.

## 0.4.0 — 2026-09-08 (CONTRACT CHANGE #162 + #180; tag contracts-v0.4)

- Admin API 0.4.0 (93 operations, was 87): the `search` area from CONTRACT CHANGE #162 (window 9, task 2.2), additive. `/admin/stores/{storeId}/merchandising/rules` list + create, `…/rules/{ruleId}` get + patch + delete, `…/merchandising/publish` (replaces the store's Algolia rules with every enabled rule, answers `{ index, published, skipped }`, 409 when the store has no search index). One rule per store + scope (`category` by `category_id` or `query` matched case-insensitively as the whole query); `pins` (ordered, ≤ 50), `boosts` (`{ product_id, weight 1..100 }`, ≤ 200), `buries` (≤ 200), `enabled`, `starts_at`/`ends_at`, `published_at`. Scope is immutable after create; list fields replace the whole list when patched.
- Permissions: reads (`listMerchandisingRules`, `getMerchandisingRule`) `store_staff`; writes and publish `store_admin`; all on `store:{storeId}`.
- New components: `MerchandisingScope`, `MerchandisingBoost`, `MerchandisingRuleInput`, `MerchandisingRulePatch`, `MerchandisingRule`; example `MerchandisingRuleCategory` (rule `3000…0501` on category `…0201`).
- #180 (window 4): every admin operation now documents `'401'` (`Unauthorized`) and `'403'` (`Forbidden`) — not only `catalog`, uniformly across all 93 operations (`getMe` has no `x-permission`, so 401 only). Additive: no existing response changed shape; Prism can now answer `Prefer: code=403` on any operation, so the admin app's refusal panel can be driven from the spec's own example. Spec test "every admin operation documents 401 and 403" keeps it that way.
- Database: `@platform/db` 0.2.1 migration 0130 `merchandising_rule` (the SQL from #162 verbatim).
- `CONTRACTS_VERSION = '0.4.0'`; types regenerated; `test:contract` walks create rule → publish → list → get/patch/delete plus the `Prefer: code=403` / `code=401` refusals.

## 0.4.1 — 2026-09-14 (CONTRACT CHANGE #168 + #189 + #194; tag contracts-v0.4.1)

- Admin API 0.4.1 (100 operations, was 93), additive.
- #168 (window 9, task 2.3) product media, tag `catalog`: `POST /admin/stores/{storeId}/media/upload-params` (`store_staff`; signed Cloudinary direct-upload params — `api_key`, `timestamp`, `signature`, the signed `params`, `max_bytes`, `allowed_formats`; the API secret never leaves the server; 409 when the store has no credentials), `GET|POST /admin/stores/{storeId}/products/{productId}/media` and `PATCH|DELETE …/media/{mediaId}` (`viewer` read, `store_staff` write — the product operations' relations). Per item: `alt` required (1..500), `position` server-owned and contiguous (insert at / move / renumber on delete), `variants: { thumb, pdp, zoom }` delivery URLs. New components `MediaUploadRequest`, `MediaUploadParams`, `ProductMediaInput`, `ProductMediaPatch`, `ProductMedia`; example `ProductMediaFront` (media `…0221` of product `…0201`). `ProductInput.media[].alt` stays nullable on the whole-set path.
- #189 (window 9, task 2.5) promotions, tag `pricing`: `PromotionInput.type` += `buy_x_get_y`; `stackable` / `exclusive` (boolean, default false, required on `Promotion`); rules extracted into `PromotionRules` and extended with `buy_quantity`, `get_quantity` (≥ 1) and `get_discount_bp` (1..10000, default 10000 = free). New `GET /admin/stores/{storeId}/promotions/{promotionId}` (`viewer`) and `PATCH` `updatePromotion` (`store_admin`, body `PromotionPatch` = every input property except the immutable `code` / `type`). Storage is the `promotion.rules` jsonb column (manager decision, no new columns); the one db statement is `@platform/db` 0.2.2 migration 0150. `createPromotion` now documents `400` (Prism answered 422 for a bad body because the response was undocumented).
- #194 (window 17, task 2.2) feeds: `ProductFeed` is spelled out instead of `allOf[ProductFeedInput, …]` — under `allOf` a value must satisfy every branch, so the overridden `status` enum could never validate `error` and the generated type lost it. `ProductFeedInput.status` stays `draft | active | paused` (omitted on create → draft; `updateFeed` is the only way to pause / resume); `ProductFeed.status` is `draft | active | paused | error`. Example `FeedGoogleError` on `getFeed` / `publishFeed` (`Prefer: example=googleError`). Sweep of every other `allOf` component (PriceList, Promotion, Order, Campaign, Segment, ReferralProgram): none restates a property of its base — the spec test "no allOf[XInput, …] component overrides a property its input branch already defines" keeps it that way.
- Every new operation documents `401` and `403` (#180). `CONTRACTS_VERSION = '0.4.1'`; types regenerated; spec tests + 4 (media permission matrix, promotions, feeds, allOf sweep); `test:contract` + 3 (upload params → add → move → list → delete; create `buy_x_get_y` → get → patch; a feed in `error` validates and the input cannot claim it).

## 0.4.2 — 2026-09-19 (CONTRACT CHANGE #172, order line-item edits; contracts-v0.4.2)

- Admin API 0.4.2 (102 operations, was 100): `PATCH /admin/stores/{storeId}/orders/{orderId}/line-items/{lineItemId}` (`updateOrderLineItem` — lower a line's quantity before fulfilment; totals recomputed, the difference recorded in `order.metadata.edits`, no money moved) and `DELETE` (`cancelOrderLineItem` — the last line cannot be cancelled, cancel the order instead). Both `store_admin` on the store, both document 401/403 per #180. Producer: window 1 wires the routes to the existing `decreaseLineQuantity` / `cancelLine` in `apps/core/src/modules/orders/edits.ts`; consumer: window 4 (admin order detail).
- `CONTRACTS_VERSION = '0.4.2'`; types regenerated. Ships with db 0.3.0 (migration 0140 `webhook_event`, #187).

## 0.4.3 — 2026-09-19 (CONTRACT CHANGE #225 pick/pack + #228 price_changed; contracts-v0.4.3)

- Admin API 0.4.3 (105 operations, was 102): `POST /admin/shipments/{shipmentId}/pick` (`pickShipment`), `POST …/pack` (`packShipment`, optional parcel_count) and `GET /admin/stores/{storeId}/pick-lists` (`listPickLists`, grouped by warehouse) — all `operations` on `organization:hq` like `updateShipment`; `Shipment.status` enum gains `picking` / `packed` (additive). Producer: window 8 (2.5); consumer: window 4.
- Store API 0.3.1: `price_changed` joins the stable machine codes and completeCart's 409 documents it with an example (`details.items[]` with previous/new unit price; `unit_price_minor: null` = no longer sellable). Nothing was placed or authorized on that 409; the same Idempotency-Key retries. Producer: window 1 (#229, already live behind a local union type it now deletes); consumer: window 3 ("prices changed" screen). The order read's `shipments[].status` enum gains `picking` / `packed` too — the core passes shipment statuses through, so both specs carry the widened set (caught by typecheck at the landing).
- `CONTRACTS_VERSION = '0.4.3'`; types regenerated. Ships with db 0.3.1 (migration 0160) and events 0.3.0 (three fulfillment.* schemas).

## 0.4.4 — 2026-09-19 (CONTRACT CHANGE #239, frozen SegmentRules grammar; contracts-v0.4.4)

- Admin API 0.4.4 (105 operations, unchanged): `SegmentRules` replaced with the grammar window 17 froze in 2.3 (#147) — `{ v: 1, all: [{ any: [predicate…] }] }`, AND of ORs over a CLOSED predicate set (`SegmentPredicate`, six branches, every one `additionalProperties: false`); unknown fields/operators/keys are 400 `validation_error` naming the offending path; the module publishes the same grammar as `SEGMENT_RULES_SCHEMA`. The stale flat-shape examples in listSegments/listSegmentTemplates and `SegmentVip`/`SegmentTemplateVip` rewritten. Technically breaking for a client sending the old flat shape — nothing does: the segment routes shipped for the first time in #240 already refusing it, admin 2.5 is unwritten, window 16 consumes members not rules.
- Data-model truths recorded in the schema text: `tags` reads `customer.metadata.tags` (missing/non-array = no match, never an error); `country` matches the DEFAULT SHIPPING address only; `customer_group_ids` is membership-in-list against the single FK.
- `CONTRACTS_VERSION = '0.4.4'`; types regenerated.

## 0.4.5 — 2026-09-20 (CONTRACT CHANGE #244 + #245, abandoned-cart recovery; contracts-v0.4.5)

- Admin API 0.4.5 (106 operations): `GET /admin/stores/{storeId}/marketing/reports/abandoned-carts` (`viewer` on the store, the reports convention) + `AbandonedCartReport` — abandoned/redeemed/recovered counts ("sent vs opened vs bought" tells a bad link from a bad offer), recovery_rate, values in the store default currency, cancelled orders excluded from both recovered figures (the attribution house rule).
- Store API 0.4.0 (21 operations): `POST /store/cart-recovery/{token}` (`recoverCart`) — single-use redemption returning the reactivated cart; one 404 for unknown/expired/redeemed (a recovery link is a bearer credential — no probing); 409 for an already-completed cart; POST not GET so prefetchers cannot burn the token. Handler mounted by window 1 (#246); page by windows 3/10 (#247).
- `CONTRACTS_VERSION = '0.4.5'`; types regenerated. Ships with db 0.3.2 (migration 0170). The landing deletes marketing's proposed/0170 copy and its test-side DDL applications (the suites now run off the migration); the module's local AbandonedCartReport type and permissionOrProposed fallback go in window 17's own cleanup PR.

## 0.4.6 — 2026-09-24 (CONTRACT CHANGE #261, examples only; contracts-v0.4.6)

- Examples for the five example-less operations (updateOrderLineItem, cancelOrderLineItem via `OrderDetail`; pickShipment / packShipment via new honest `ShipmentPicking` / `ShipmentPacked` named examples — the issue's cleaner option, a pick answer must not claim status pending; listPickLists inline). No schema, path or permission changes: Prism answered 500 for these because its schema-generated bodies fail its own validation. `CONTRACTS_VERSION = '0.4.6'`; types regenerated (no type changes expected).

## 0.4.7 — 2026-09-28 (CONTRACT CHANGE #270 + #264 + #279; contracts-v0.4.7)

- Store API 0.5.0 (22 operations): the typed review shape (#270) — `Review` (author is a display name provided or chosen AT REVIEW TIME, never derived from the account: the manager's PII constraint, in the schema comment), `ReviewSummary` (`average` null when count is 0, never 0), `ReviewPage`, optional `Product.review_summary` (omitted = no reviews feature, null/summary = has one), and read-only `GET /store/products/{handle}/reviews`. The storefront deletes its free-form `attributes.reviews` parser when a producer exists; until then the shape is authoritative for feeds and JSON-LD.
- Admin API 0.4.7 (111 operations): #264 customers — `listCustomerAddresses` (`support`, extends the shared `Address`), `exportCustomer` (202, `store_admin`; bundle format is window 13's Phase 3 decision), `listCustomerGroups` (`viewer`); #279 registry — `revokeApiKey` (idempotent, 409 `last_live_key` on the store's last live publishable key), `PATCH /admin/stores/{storeId}/domains/{domainId}` (`owner`, moves the primary; clearing the current primary is 409), `Store.currencies`/`locales` in the response — OPTIONAL until window 1's registry bundle returns them (recorded deviation on #279; the bundle flips both to required) — with `StoreInput` replace-the-whole-set semantics.
- `ERROR_CODES` += `last_live_key`. `CONTRACTS_VERSION = '0.4.7'`; types regenerated. Core-side registry work (set replacement, revoke, primary move) is window 1's, bundled with #265 and #284.

## 0.4.8 — 2026-10-02 (#279 required flip + #303 customer self-service + CONTRACT CHANGE #310; contracts-v0.4.8)

- Admin API 0.4.8 (111 operations, unchanged): `Store.currencies` and `Store.locales` are **required** — the recorded 0.4.7 deviation
  (optional until the core returned them) ends with core #308; `revokeApiKey` documents `400` (malformed key id).
- Store API 0.5.1 (22 operations, unchanged): `registerCustomer` documents `200` (the row already existed; names and consent applied),
  `400` (body `email` differs from the token's — subject and email always come from the customer token) and `409` (`conflict`: the email
  belongs to a row that cannot be adopted); the `/store/customers/me*` operations create the store-level row from the verified token on
  first use and document `409` for the same collision (`addMyAddress` also gains the missing `401`); `createCart` and `completeCart`
  accept an OPTIONAL customer token (#310): a valid token links the cart / the placed order to that customer, a token that is sent but
  invalid is a `401` and never ignored, a cart linked to another customer is a `409` `conflict` at completion. New shared `Conflict`
  response. No schema change: neither `Cart` nor `Order` exposes `customer_id`.
- `CONTRACTS_VERSION = '0.4.8'`; types regenerated. Producers: window 1 (#303 PR A/B/C). Consumers: window 3 (the storefront sends the
  customer token on cart create/complete when signed in), window 4 (settings cards may rely on the sets), brands by re-sync.

## 0.4.9 — 2026-10-03 (#303 PR B; contracts-v0.4.9)

- Store API 0.5.2 (22 operations, unchanged): `addMyAddress` takes optional `is_default_shipping` / `is_default_billing` (the first
  address is the default for both; a flag moves the default to the new address inside the core's locked transaction; the shared
  `Address` schema is untouched because carts use it); `updateMe` and `listMyOrders` document `400` (wrong body type / invalid
  page or limit — the deviations recorded on #303 end here). `listMyAddresses` documents no 400 on purpose: no query, no body.
- Admin API unchanged. `CONTRACTS_VERSION = '0.4.9'`; types regenerated. Producer: window 1 (#303 PR B). Consumers: window 3
  (#312 later), brands by re-sync.

## 0.4.10 — 2026-10-04 (#303 PR C follow-up; contracts-v0.4.10)

- Store API 0.5.3 (22 operations, unchanged): `createCart` documents `409` `conflict` — only with a customer token, when the
  token's email already belongs to another account in the store; no cart is created (the deviation recorded on #325 ends here).
  `addMyAddress`: `is_default_shipping` / `is_default_billing` lose `default: false` — it contradicted "absent on the first
  address = default"; the rule is now in the property descriptions. No behaviour change, no new field.
- Admin API unchanged. `CONTRACTS_VERSION = '0.4.10'`; types regenerated. Producer: window 1 (already merged, #325).
  Consumers: window 3 (nothing to change: the storefront maps `conflict` already), brands by re-sync.
