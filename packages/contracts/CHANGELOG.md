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

## 0.4.11 — 2026-10-06 (CONTRACT CHANGE #354 + the #350 lifecycle, Integration 2a; contracts-v0.4.11)

- Admin API 0.4.9 (113 operations, was 111), additive:
  - `POST /admin/stores/{storeId}/orders/{orderId}/payments/{paymentId}/capture` (`capturePayment`, tag `orders` next to
    `createRefund` — there is no `payments` tag; `store_admin` on `store:{storeId}`): optional body `{ amount_minor? ≥ 1 }`
    (partial capture, at most the authorised amount; omitted = the whole authorisation); 200 the `Payment` with status
    `captured` (example `PaymentCaptured`); 404; 409 when the payment is not `authorized` or the amount exceeds it; 422 when
    the provider cannot capture (the manual provider). New `PaymentId` path parameter. Emits `payment.captured` (v1, unchanged).
  - `POST /admin/shipments/{shipmentId}/label` (`buyShipmentLabel`, tag `fulfillment`, `operations` on `organization:hq` like
    pick/pack): no body; 200 the `Shipment` with `label_url`, `tracking_number`, `tracking_url` and status `label_created`
    (example `ShipmentLabelCreated`); 404; 409 unless the shipment is `packed`; 422 when the store's carrier cannot buy
    labels (the manual carrier). Emits `shipment.label_created` (events 0.3.1).
  - New shared `Unprocessable` (422) response with machine code `provider_unsupported` (listed in `Error.code`; NOT yet in
    `ERROR_CODES`: the core's `Record<ErrorCode, number>` status map in `apps/core/src/lib/errors.ts` would stop
    typechecking — window 1 adds the code with its 422 mapping when it wires the routes).
  - Order status lifecycle (manager decision on #350) documented on the `Order` schema; the enum is unchanged
    (`pending | confirmed | processing | completed | cancelled`): `pending` = placed, payment not yet authorised ·
    `confirmed` = payment authorised (automatic; at placement for the manual provider and for a succeeded Stripe
    session; emits `order.confirmed`) · `processing` = the first shipment leaves planned (automatic; emits
    `order.updated`) · `completed` = every shipment is `delivered` (automatic; emits `order.completed`) · `cancelled` =
    `cancelOrder` (explicit). No `markShipmentDelivered`: `updateShipment` already moves a shipment to `delivered`
    (409 on an illegal transition), so a manual-carrier order can reach `completed` without a database edit.
- Store API 0.5.4 (22 operations, unchanged; manager addition on #354 from window 3's #358 plan): OPTIONAL `Store.payment`
  `{ methods: ('card' | 'invoice')[] }` (unique items) on `GET /store` — `card` when the store has a Stripe key configured,
  `invoice` (the manual provider) when `settings.payment.invoice_allowed` is true (default false in production, true in the
  seed). Derived by the core (#350/#358); absent = the storefront's own default. Not in `required` until the core returns it
  (optional-until-returned, as `Store.currencies` / `locales` were in 0.4.7). Example `StoreBrandA` carries
  `methods: [card, invoice]`.
- Events 0.3.1 (`shipment.label_created`). db unchanged (0.3.2).
- `CONTRACTS_VERSION = '0.4.11'`; types regenerated; spec tests + 3 (the Store API `payment` property; the two operations with permissions, 200/404/409/422
  and honest examples; the five-state lifecycle). Producers: window 1 (#350 lifecycle, capture), the shipping module
  (label). Consumers: window 4 (admin order and fulfilment screens).

## 0.4.12 — 2026-10-06 (`provider_unsupported` in `ERROR_CODES`; contracts-v0.4.12)

- Admin API 0.4.10 (113 operations, unchanged): `buyShipmentLabel`'s description documents the carrier-outage deviation —
  a carrier that is merely unavailable answers 502 (retryable); 422 `provider_unsupported` means the store's carrier can
  never buy labels. Prose only: no 502 response object (the spec documents no 5xx anywhere). Version history line added.
- `ERROR_CODES` += `provider_unsupported` (after `last_live_key`, before `internal`), ending the 0.4.11 "NOT yet in
  `ERROR_CODES`" note. The one consumer-side touch is the core's status map (`apps/core/src/lib/errors.ts`:
  `provider_unsupported: 422`), as 0.4.7 did for `last_live_key`. The local `as ErrorCode` casts in the payments
  (and, once merged, shipping) modules are removed by windows 7 and 8 in their own follow-ups.
- Store API 0.5.4, events 0.3.1, db 0.3.2 unchanged. `CONTRACTS_VERSION = '0.4.12'`; types regenerated.

## 0.4.13 — 2026-10-08 (store onboarding, CONTRACT CHANGE #417 for core 3.1 #413; contracts-v0.4.13)

- Admin API 0.4.11 (115 operations, +2): `onboardStore` (`POST /admin/onboarding/stores`, `owner` on `organization:hq`) creates
  the legal entity (inline `LegalEntityInput`, or an existing `legal_entity_id` — exactly one, else 400), the store in `draft`
  with the server-owned conventions (`content_space_id = <code>`, `search_index = <code>_products`), its primary domain, the
  locales and currencies (defaults first), one `web` sales channel and one publishable key, all in one transaction with the
  audit row and `store.created`, then registers the store's OpenFGA object; 201 `StoreOnboarded` with the plain key shown
  once, 200 with `publishable_key: null` when the same input is repeated (idempotent by `code`, no `Idempotency-Key`), 409 for
  the same `code` with different input or a hostname already taken. `activateStore` (`POST /admin/stores/{storeId}/activate`,
  `owner` on hq): `draft`/`paused` → `active` when every prerequisite is present, else 409 `ActivationBlocked` with the closed
  list `details.missing[]` (`legal_entity`, `locale`, `currency`, `primary_domain`, `publishable_key`, `fga_object`); `active`
  again is a 200 no-op; `archived` → 409 `details.status`. `updateStore` gains 404, the same 409 when `status: active` is
  requested, and 422 `InvalidSettings`.
- `StoreInput.settings` stays `additionalProperties: true`; the keys the core reads (listed in the registry README, not here)
  are checked by shape on `onboardStore` and `updateStore`: a wrong type answers 422 `validation_error` with
  `details.settings` naming the key; unknown keys are preserved. New components: responses `ActivationBlocked`,
  `InvalidSettings`; schemas `LegalEntityInput`, `StoreOnboardingInput`, `ApiKeyCreated`, `StoreOnboarded`; example
  `StoreOnboardedBrandC`.
- No `ERROR_CODES`, events or db change (`store.created` / `store.updated` as today; events 0.3.1, db 0.3.3, Store API 0.5.4).
  `CONTRACTS_VERSION = '0.4.13'`; types regenerated. Producer: window 1 (#413). Consumer: window 4 (onboarding wizard, later).

## 0.4.14 — 2026-10-08 (inviteUser 400 #423 + events 0.3.2 #425; contracts-v0.4.14)

- Admin API 0.4.12 (115 operations, unchanged): `inviteUser` lists the `400` `BadRequest` response it already answers for an
  invalid body (`email` not an address, empty `display_name`), like `assignRole`; `createStore` lists the `422` `InvalidSettings`
  response the settings shape check (0.4.13 decision 4) also produces there — found by the #424 review, recorded on #417. No schema change.
- Events 0.3.2: `customer.export_requested` v1 (ids only: `customer_id`, `requested_by`, `requested_at`) — the topic
  `exportCustomer`'s description has promised since 0.4.x; the outbox can now carry it. Producer: the core's customers
  module (#414). Consumer: the GDPR export delivery (Integration 2b).
- Store API 0.5.4, db 0.3.3 unchanged. `CONTRACTS_VERSION = '0.4.14'`; types regenerated.

## 0.4.15 — 2026-10-12 (stock pool step 2, CONTRACT CHANGE #453; contracts-v0.4.15)

- Admin API 0.4.13 (117 operations, was 115): `listStockItems` (`GET /admin/stock-items`, `viewer` on hq; filters `sku`,
  `store_id`, `shared`) and `mapVariantToStockItem` (`PUT /admin/stock-items/{stockItemId}/variants/{variantId}`,
  `operations` on hq). The mapping is idempotent (already mapped = 200, nothing written), answers 409 while the variant's
  current item still holds on-hand stock or an open reservation at any warehouse (quantities are never merged silently),
  and otherwise writes one audit row and one `stock_item.mapped` v1 outbox event in the same transaction. New schemas
  `StockItem` (with its mapped `variants` and pool `levels`) and `StockLevel`.
- `InventoryLevel` is one row per variant and warehouse carrying the numbers of the POOL row of the stock item the variant
  maps, with a required `stock_item_id`. `id` is the pool row's, so it repeats when two variants in one response share an
  item: key rows by (`variant_id`, `warehouse_id`) and never sum `on_hand`, `reserved` or `available` across variants
  (window 4: note for the admin inventory screens). `reserved` counts every store's open reservations on the pool row.
- Events 0.3.3: `stock.moved` v2 (requires `stock_item_id`; `variant_id` + `store_id` together or absent) and
  `stock_item.mapped` v1 (ids only). db 0.3.5: migration 0191 (levels keyed by stock item and warehouse; RLS kinds `pool` /
  `pool_ledger`) and the seed's shared item. Store API 0.5.4 unchanged; no `ERROR_CODES` change.
- `CONTRACTS_VERSION = '0.4.15'`; types regenerated. Producer: window 1 (inventory rewrite, #456) with window 11
  (allocation, #435). Consumers: window 4 (admin), every `stock.moved` consumer.

## 0.4.16 — 2026-10-13 (cycle counts, CONTRACT CHANGE #458; contracts-v0.4.16)

- Admin API 0.4.14 (120 operations, was 117), all three `operations` on `organization:hq`, tag `inventory`:
  `listCycleCounts` (`GET /admin/cycle-counts`; filters `warehouse_id`, `stock_item_id`, `status`; newest count first),
  `createCycleCount` (`POST /admin/cycle-counts`, 201: writes the count down as `recorded` and changes no stock) and
  `reconcileCycleCount` (`POST /admin/cycle-counts/{cycleCountId}/reconcile`, optional body `{ approve }`). New schema
  `CycleCount`. There is no update and no delete: a count is a record.
- Reconciling turns the discrepancy into exactly one stock movement (reason `cycle_count`, no store, one `stock.moved`
  in the same transaction) and status `applied`; a zero delta is `applied` with no movement. Above
  `organization.settings.warehouse.count_tolerance` nothing moves and the answer is a 200 with status `flagged` — not an
  error — until a call with `approve: true` applies it. Idempotent by count.
- No new error code (the amendment on #458): a count superseded by an applied count with the same or a later
  `counted_at` answers 409 `conflict` with `details: { reason: 'superseded', applied_cycle_count_id }`, at record time
  and at reconcile time; a `counted_at` in the future answers 422 `validation_error` with
  `details: { field: 'counted_at' }`. `ERROR_CODES` is unchanged (the 0.4.13 precedent: `ActivationBlocked`,
  `InvalidSettings`).
- The text is window 11's proposed file verbatim; the landing adds a schema-valid `example` to the three success
  responses (the mock answers from examples) and nothing else. test/contract.test.ts walks list → record → reconcile on
  the mock.
- db 0.3.6: migration 0192 (`cycle_count`, RLS kind `organization_only`). Events 0.3.3 and Store API 0.5.4 unchanged: no
  new topic, no envelope change — reconciliation emits `stock.moved` v2 through the inventory module.
- `CONTRACTS_VERSION = '0.4.16'`; types regenerated. Producer: window 11 (hq-warehouse, #436). Consumer: window 4 (admin).

## 0.4.17 — 2026-10-15 (Order.payment_status `voided`, CONTRACT CHANGE #466; contracts-v0.4.17)

- Admin API 0.4.15 and Store API 0.5.5: the order's `payment_status` (`OrderSummary`, so `Order` too, in the Admin
  API; the order read in the Store API) gains `voided` — the authorization was released by `cancelOrder` before any
  capture (the payment row is `cancelled`). authorized → voided when an order is cancelled; `voided` is terminal.
  Additive: no operation, parameter, example or error code changes. `listOrders`' `payment_status` query parameter is
  a free string, so `voided` is filterable as is.
- Contract only: the core starts writing the value in a later PR (window 1, after #465). No backfill (manager decision
  on #466).
- events 0.3.4: `order.updated` v1's `payment_status` enum gains `voided` in place (the decision: every producer and
  reader is inside apps/core, no consumer before Phase 4). db 0.3.7: migration 0193 widens
  `order_payment_status_check`.
- `CONTRACTS_VERSION = '0.4.17'`; types regenerated. Producer: window 1 (core, `cancelOrder`). Consumers: window 4
  (admin orders table, label "Voided", neutral tone), the storefronts' order read.

## 0.4.18 — 2026-10-15 (stock pool reads, CONTRACT CHANGE #469; contracts-v0.4.18)

- Admin API 0.4.16, three HQ-only reads (additive):
  - `listStockItemMovements` — `GET /admin/stock-items/{stockItemId}/movements` (`viewer` on `organization:hq`;
    `warehouse_id`, page, limit): the pool row's ledger, newest first, pool movements (no store) and store-caused ones.
  - `listStockItemReservations` — `GET /admin/stock-items/{stockItemId}/reservations` (`viewer` on
    `organization:hq`; `warehouse_id`, `status` = `open` (default) | `released` | `all`, page, limit): every
    store's reservations with the `allocation_rule` that placed each (a free string because of `split:<rule>`).
  - `previewCycleCountReconcile` — `GET /admin/cycle-counts/{cycleCountId}/reconcile-preview` (`operations` on
    `organization:hq`): what `reconcileCycleCount` would do now, without writing and without the pool row's lock;
    404 and 409 (`superseded`) as reconcile. A separate safe GET, not a flag on the POST (manager decision on #469).
  - New components `StockMovement`, `StockReservation`, `CycleCountPreview`; examples on every 200 (the mock answers
    from them).
- No events, db or Store API change; no new error code. A store-scoped variant of (a)/(b) is out of scope.
- `CONTRACTS_VERSION = '0.4.18'`; types regenerated. Producers: window 1 (inventory module, a + b), window 11
  (hq-warehouse, c). Consumer: window 4 (admin, #468 follow-up).

## 0.4.19 — 2026-10-15 (InventoryLevel.warehouse_code, CONTRACT CHANGE #475; contracts-v0.4.19)

- Admin API 0.4.17: `InventoryLevel` gains `warehouse_code` (string, `readOnly`, REQUIRED) — the `code` of the
  warehouse the row already names by `warehouse_id`, so a store principal (store_admin, store_staff) can name the
  warehouse without `listWarehouses` (`viewer` on `organization:hq`, a 403 for them). No operation, parameter,
  permission or error code changes; no migration (a join to `warehouse.code`).
- Examples: `warehouse_code: wh-eu` on the `InventoryLevel` of `listInventoryLevels` (200) and
  `createStockMovement` (201) — the only two operations answering an `InventoryLevel`.
- Required in the response, so it lands with the producer (manager decision on #475). `CONTRACTS_VERSION =
'0.4.19'`; types regenerated. Producer: window 1 (core inventory module, the level projection selects
  `warehouse.code`). Consumer: window 4 (admin Store · Inventory warehouse column and filter).

## 0.4.20 — 2026-10-18 (customer self-service, CONTRACT CHANGE #482; contracts-v0.4.20)

- Store API 0.5.6, four operations (publishable key + customer token, 401 and the resolve-or-provision 409 like every
  `/store/customers/me*` operation):
  - `updateMyAddress` — `PATCH /store/customers/me/addresses/{addressId}`: partial (every field optional, `null`
    clears `company` / `line2` / `region` / `phone`), default flags as `addMyAddress`; 200 `CustomerAddress`,
    400, 404 (another customer's address or an unknown id).
  - `deleteMyAddress` — `DELETE /store/customers/me/addresses/{addressId}`: the oldest remaining address takes a
    removed default flag; **200 `{ items }`** (the remaining addresses, the `listMyAddresses` shape), not 204
    (manager decision on #482: no Store API 204, the account page needs the new list anyway); 404.
  - `requestMyExport` — `POST /store/customers/me/export`: 202; one `customer.export_requested` v2
    (`requested_by_type: customer`) per call, no dedupe.
  - `deleteMe` — `DELETE /store/customers/me`: 202; erases this store's customer row as the Admin API
    `eraseCustomer` does; the Keycloak subject stays on the erased row as a tombstone; a replay is a 202 no-op.
  - New path parameter `AddressId`. Examples on every 2xx with a body (the mock answers from them).
- events 0.3.5: `customer.export_requested` v2 (`requested_by_type` `staff` | `customer`, required); v1 stays
  registered and frozen; `makeEvent` writes v2. No db change.
- `CONTRACTS_VERSION = '0.4.20'`; types regenerated. Producer: window 13 (core customers module, the admin export
  path too: `requested_by_type: staff`). Consumers: the storefronts' account page (window 13).

## 0.4.21 — 2026-10-18 (customer consent ledger, CONTRACT CHANGE #489; contracts-v0.4.21)

- Store API 0.5.7, two operations on `/store/customers/me/consents` (publishable key + customer token, 401 and the
  resolve-or-provision 409 like every `/store/customers/me*` operation):
  - `getMyConsents` — `GET`: the current decision per purpose in this store, `CustomerConsents` `{ items }`, one item
    per purpose of the closed set (`marketing_email` only until the lawyer review).
  - `putMyConsents` — `PUT`: `{ policy_version (required, non-blank), consents: [{ purpose, granted }] (≥ 1) }`; one
    ledger row per purpose whose answer changes, an unchanged answer writes nothing, a first explicit `false` is
    recorded; 200 with the current state, 400 naming the field.
  - New schemas `CustomerConsent` (`granted` `true | false | null` — `null` = never asked, distinct from a refusal;
    `source` / `policy_version` / `recorded_at` nullable for the never-asked item) and `CustomerConsents`.
  - `updateMe` gains a description: `marketing_consent` stays the one-checkbox shortcut (shape unchanged) and also
    writes the ledger (`source: storefront`, the store's `settings.privacy.policy_version`, `unversioned` when unset).
- Admin API 0.4.18: `listCustomerConsents` — `GET /admin/stores/{storeId}/customers/{customerId}/consents` (`support`
  on `store:{storeId}`, the record's gate), the ledger newest first, optional `purpose` query; 401 / 403 / 404 (404
  as `getCustomer`: unknown, another store's, or erased — the ledger is gone).
- Examples on every 2xx (the mock answers from them); `test:contract` walks get → put (and three bad bodies), the
  /me 409, and the admin list with its 403 / 404.
- db 0.3.9: migration 0194 `customer_consent` (append-only, RLS store, backfilled from the projection). No event
  change: `customer.updated` keeps `changed_fields: ['marketing_consent']`. The `never_asked` segment operator is NOT
  part of this landing (#491).
- `CONTRACTS_VERSION = '0.4.21'`; types regenerated. Producer: window 13 (core customers module, `consent.ts`).
  Consumers: the storefronts' Privacy section (window 13), the admin customer view.

## 0.4.22 — 2026-10-18 (reporting v1 reads, CONTRACT CHANGE #493; contracts-v0.4.22)

- Admin API 0.4.19, four reads under the new `reports` tag over the reporting views (the fragment
  `data/reporting/proposed/admin-api.reports.yaml` merged verbatim):
  - `getStoreSalesReport` — `GET /admin/stores/{storeId}/reports/sales` (`viewer` on `store:{storeId}`): one row per
    UTC day and currency over `[from, to)`, `totals` per store and currency, `currency_totals` per currency;
    `net_minor` is cohort-attributed. 400 / 401 / 403 / 404.
  - `getStoreStockReport` — `GET /admin/stores/{storeId}/reports/stock` (`viewer` on `store:{storeId}`): the current
    position of the pool rows the store sells from, paged (`Page` / `Limit`). 400 / 401 / 403 / 404.
  - `getHqSalesReport` — `GET /admin/hq/reports/sales` (`analyst` on `organization:hq`): the store report for every
    store. 400 / 401 / 403.
  - `getHqFinanceReport` — `GET /admin/hq/reports/finance` (`finance` on `organization:hq`): captured payments by
    capture day, PSP fees known so far and succeeded refunds by refund day (with `refunded_by_reason`), per store and
    currency; `fees_reconciled` is `const: false` until Integration 4. No ledger figures in v1. 400 / 401 / 403.
  - New query parameters `ReportFrom` (required, inclusive), `ReportTo` (required, exclusive, at most 366 days after
    `from`) and `ReportCurrency` (optional, `^[A-Z]{3}$`); new schemas `SalesFigures`, `SalesReport`,
    `StockPosition`, `StockReport`, `FinanceFigures`, `FinanceReport`. Amounts are integer minor units beside their
    currency, never summed across currencies; no customer field. No new error code.
- Examples on every 200 (the mock answers from them); `test:contract` reads all four and checks the 400 on a missing
  `to` or a lower-case currency and the documented refusals.
- `CONTRACTS_VERSION = '0.4.22'`; types regenerated. No events or db change.
  Producer: window 12 (core reporting module, `reportingAdminRouter`, which reads each `x-permission` from this
  spec). Consumers: the admin BI section (#480).

## 0.4.23 — 2026-10-18 (customer export delivery, CONTRACT CHANGE #498; contracts-v0.4.23)

- `ERROR_CODES` gains `expired` (before `internal`); the `Error.code` description in both specs lists it. New shared
  response `Gone` (410, `expired`, `details.expires_at` says when) in both specs.
- Store API 0.5.8 (30 operations, was 28), both customer-token secured with the `/me` resolve-or-provision 409:
  - `listMyExports` — `GET /store/customers/me/exports`: the customer's export requests in this store, newest first,
    as `CustomerExportSummary` (`status` `pending | ready | expired`, `requested_at`, `ready_at`, `expires_at`,
    `size_bytes`, `reason` `customer_gone | too_large | null`). Ids, timestamps and sizes only. 401 / 409.
  - `getMyExport` — `GET /store/customers/me/exports/{exportId}`: downloads one of the customer's own ready bundles
    (`customer-export/v1`, `application/json`, `Content-Disposition: attachment`). Another customer's, unknown,
    malformed or pending → 404; expired / purged → 410 `expired`. 401 / 404 / 409 / 410.
- Admin API 0.4.20 (130 operations, was 128), both `store_admin` on `store:{storeId}`:
  - `listCustomerExports` — `GET /admin/stores/{storeId}/customers/{customerId}/exports`: the summaries plus
    `requested_by`, `requested_by_type`, `download_count`; never the bundle. 400 / 401 / 403 / 404.
  - `getCustomerExport` — `GET …/customers/{customerId}/exports/{exportId}`: downloads one ready bundle (every
    download is audited). 400 / 401 / 403 / 404 / 410.
  - `CustomerExportSummary` added to the Admin components (same shape as the Store API's).
  - #496 follow-up: `listCustomerConsents` documents `400` (a bad `?purpose`, a non-uuid `customerId`); the mock now
    answers the house 400 instead of Prism's own 422.
- events 0.3.6: `customer.export_ready` v1 (ids and `expires_at` only). db 0.3.10: migration 0195 `customer_export`.
- `CONTRACTS_VERSION = '0.4.23'`; types regenerated; spec tests pin the versions, operation counts (Store 30,
  Admin 130), the permissions, the error list and the `Gone` component; `test:contract` reads both lists and
  downloads, and drives the documented 400 / 403 / 404 / 409 / 410.
  Producer: window 13 (core customers module, export job #472). Consumers: the storefronts' Privacy section, the
  admin customer view; the mail is window 17's (`customer.export_ready`).

## 0.4.24 — 2026-10-18 (cross-brand identity, CONTRACT CHANGE #504; contracts-v0.4.24)

- Admin API 0.4.21 (131 operations, was 130): `getCustomerIdentity` — `GET /admin/customer-identities/{identityId}`
  (tag `customers`, next to `/admin/users`), `support` on `organization:hq`. Answers
  `{ id, customers: [{ store_id, customer_id }] }` — ids only, no email hash, no subject, no email; a merged identity
  answers the identity it was merged into. Per the manager's condition 4 a store-scoped principal gets 403 (the read
  needs the HQ relation) and 404 means an unknown identity. 401 / 403 / 404; an example on the 200 (the mock answers
  from it).
- Store API unchanged (0.5.8); events unchanged. db 0.3.11: migration 0196 (`customer_identity` closed to store
  sessions, keyed by subject, written through `app.link_customer_identity` / `app.unlink_customer_identity`).
- `CONTRACTS_VERSION = '0.4.24'`; types regenerated; spec tests pin the Admin version, the operation count (131), the
  permission, the path, the documented codes and the ids-only answer; `test:contract` reads the identity and drives
  the 401 / 403 / 404.
  Producer: window 13 (core customers module, `customersAdminRouter`, #473). Consumers: HQ support, the erasure /
  BI joins.

## 0.4.25 — 2026-10-19 (segment consent never_asked, CONTRACT CHANGE #508, REQUEST #491; contracts-v0.4.25)

- Admin API 0.4.22: the `SegmentPredicate` consent `op` gains `never_asked` — the projection has no block for the
  channel (no decision ever recorded). The re-consent audience is the never-asked customers only; a refusal
  (`granted: false`) and an opt-out after a grant are `not_granted`, never `never_asked`. `not_granted` stays the
  suppression list for sends. Additive: rules with the old two values stay valid. Operations unchanged (131).
- `CONTRACTS_VERSION = '0.4.25'`; types regenerated; a spec test pins the version and the enum.
  Producer: window 17 (segment grammar, segment-sql, the admin rule builder). Store API, events and db unchanged.

## 0.4.26 — 2026-10-20 (store tax rates, CONTRACT CHANGE #522 for #520; contracts-v0.4.26)

- Admin API 0.4.23 (135 operations, was 131), under `registry`, after the sales channels:
  - `listTaxRates` — `GET /admin/stores/{storeId}/tax-rates` (`viewer` on the store, optional `?country`): the table
    the `table` tax provider reads, ordered by country, region and category (nulls first), name. 400 / 401 / 403.
  - `createTaxRate` — `POST …/tax-rates` (`store_admin`): one row per (country, region, product category), enforced
    by the database (db 0.3.15 `tax_rate_identity_key`, NULLS NOT DISTINCT); a duplicate is 409 `conflict` with
    `details.tax_rate_id`. A foreign `product_category_id` is 400. 201 / 400 / 401 / 403 / 404 / 409.
  - `updateTaxRate` — `PATCH …/tax-rates/{taxRateId}` (`store_admin`): `name` and `rate_bp` only, an empty body
    is 400. 200 / 400 / 401 / 403 / 404.
  - `deleteTaxRate` — `DELETE …/tax-rates/{taxRateId}` (`store_admin`): 204; 409 `conflict`
    (`reason: last_rate_of_market_country`) for the last row of a market country of an active store.
  - `TaxRate` added to the components. The three writes emit `store.updated` v1 with
    `changed_fields: [tax_rates]` (no new topic) and an audit row.
  - `activateStore` gains the `tax_rates` prerequisite: one row per market country (`default_country` plus every
    country of the store's active shipping options); `details.missing_tax_countries` lists the uncovered ones,
    sorted. The `ActivationBlocked` example shows it.
- Store API and events unchanged. db 0.3.15: migration 0201 (the unique index) and the brand A seed rows DE / BE / FR.
- `CONTRACTS_VERSION = '0.4.26'`; types regenerated; spec tests pin the version, the operation count (135), the
  paths, permissions and codes, `TaxRate` and the activation prerequisite; `test:contract` reads the list, creates
  (201, generated from the schema: the 201 documents no example) and drives the 409.
  Producer: window 1 (core registry module, readiness, #520). Consumers: the admin store settings (tax rates).

## 0.4.27 — 2026-10-23 (Admin API 0.4.24; CONTRACT CHANGE #569, window 16 #556)

- `listOrders` (`GET /admin/stores/{storeId}/orders`) gains an optional query parameter `customer_id` (uuid): only
  the orders of that customer, combined with the other filters as they combine with each other. Additive; permission
  unchanged (`viewer` on the store); no schema change (`OrderSummary.customer_id` already existed). Reason: the
  support-context API lists one customer's orders by key, not by `q=<email>` (an e-mail in a URL, and a search that
  can match another person with the same address).
- Producer: window 1 (core orders module: one more predicate inside the tenant client, landed in the same integration
  PR). Consumer: apps/engagement support context (#556).
- Store API and events unchanged.

## 0.4.28 — 2026-10-23 (accounting 0.1.0; CONTRACT CHANGE #572, window 15 #551)

- New spec `openapi/accounting.yaml` (Accounting API 0.1.0, 7 operations, tags books / journal / payouts / erp): the
  Finance-only read API of the accounting service — `listLegalEntityBooks`, `getTrialBalance`, `listJournalLines`,
  `listParkedEvents`, `listPayouts`, `getPayout`, `getErpSyncStatus` under `/accounting/v1/legal-entities`. GET only;
  the ledger is derived from events (ADR 0003 item 6).
- Decisions: every operation is `finance` on `organization:hq` (a store admin gets 403) and documents 401 / 403, 404
  where a path id can miss, and the shared `BadRequest` (400 `validation_error`, `details` names each parameter) on
  every operation with validatable query parameters. Money is integer minor units plus an explicit `currency`, never
  summed across currencies; the trial balance is per (currency, account) with per-currency totals (difference 0 on
  balanced books; an empty period is `rows: []`, `totals: []`). `Limit` as in the house (default 20, max 100);
  `getPayout`'s lines are paginated (`PayoutLinePage`). No PII; parked events carry ids, topic and times only.
- Wiring: generated `src/generated/accounting.ts`, `@platform/contracts/accounting` export, `AccountingPaths` /
  `AccountingComponents` / `AccountingOperations` from the root, `MOCK_URLS.accounting`; `pnpm mock` starts a third Prism
  server on :4013 (`MOCK_ACCOUNTING_PORT`; 4012 is the storefront perf scripts' `PERF_MOCK_PORT`); `test:contract`
  boots it on :4112.
- Producer: apps/accounting (window 15, #551). Consumer: later the admin app's Finance screens (window 4).
- Store API (0.5.8), Admin API (0.4.24) and events unchanged.

## 0.4.29 — 2026-10-26 (Store API 0.5.9, db 0.3.19; CONTRACT CHANGE #607, window 9 P5.8)

- Store API: `GET /store/recommendations` (`listProductRecommendations`, tag `catalog`, publishable key only) and
  `RecommendationList` (`kind` served + `items` of the existing `ProductSummary`, max 24). `kind`
  `bought_together` (anchor: `product_id` or cart `variant_ids`, exactly one) | `popular` (store-wide, 7 or 30 days);
  the response `kind` reports a fallback to popular; 404 for an anchor outside the resolved store. 31 store operations.
- db 0.3.19: migration 0204 `product_recommendation` (RLS kind `store`, no UPDATE grant, composite keys to
  `product (store_id, id)`). Producer: apps/core search module + the `index-recommendations` job (window 9);
  consumer: the storefront rail (#609, window 3). Admin API and events unchanged.
- Five flow-mapping descriptions were silently cut at an unquoted comma (YAML ends a flow-mapping value at a
  comma; the rest became a bogus key): Store API `variant_ids` (#607, found by window 9) and four older Admin API
  ones (`MediaUploadParams.api_key`, `PromotionInput/PromotionPatch.value`, `SalesFigures.refunded_minor`).
  Now quoted; descriptions only, no behaviour change. New spec-test guard: no object key with whitespace in any
  spec (mutation-tested); `js-yaml` 4.3.2 + `@types/js-yaml` as contracts devDependencies for it.
