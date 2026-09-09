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
