# Changelog — marketing module (window 17)

The app-level `apps/core/CHANGELOG.md` and the module row in `apps/core/CLAUDE.md` belong to window 1; this
file is the module's own history (linked from the PRs).

## Phase 2 — marketing/phase2 (contracts-v0.3)

### 2026-09-14 · contracts-v0.4.1 landed (#194 applied by the main window)

- `proposed/product-feed.schema.json` removed; `feed-types.ts` takes `ProductFeed` / `FeedStatus` from the
  generated types and `routes.test.ts` asserts the error-status feed against the document itself.

### 2026-09-19 · 2.4 Abandoned-cart recovery (#148)

- `recovery.ts`: `consumeAbandonedCarts` — outbox polling per store on `cart.abandoned` (window 9's shape),
  creating one record per cart and advancing the `marketing_cursor` position in the same transaction.
  Idempotency is `UNIQUE (cart_id)` in the schema rather than the consumer remembering, so a replayed event or
  a rewound cursor is a no-op **and the original token keeps working**. `reconcileRecoveries` flips records
  whose carts became orders, reading `cart.order_id` — marketing never decides what an order is — and is
  idempotent on the target state, so a cart counts once. `validateRecoveryToken` is what window 1's Store API
  route calls (REQUEST #246).
- `recovery-token.ts`: 32 random bytes base64url; **only `sha256(token)` is stored**, the plaintext returned
  once at mint. Single use enforced by `UPDATE … WHERE redeemed_at IS NULL` (not check-then-write, so two
  simultaneous clicks cannot both win), 7-day expiry, constant-time hash comparison. Unknown, expired and used
  tokens answer an identical 404; a cart already ordered answers 409.
- `recovery-report.ts`: abandoned / redeemed / recovered / rate, in the store's default currency.
  `recovered_value` is the **order** total, not the cart's. No carts abandoned is `0`, not a division by zero.
- `recovery-types.ts`: the record, the read model (no `token_hash`, ever), and the report shape — declared
  locally until #245 lands, the way `ProductFeed` was before #194.
- One new route, `GET …/marketing/reports/abandoned-carts`, behind `permissionOrProposed`: it reads the
  operation's `x-permission` from the spec when present and falls back to the proposed `viewer` otherwise, so
  the document wins automatically once #245 lands — including if the manager lands a different relation.
- **This module writes no attribution.** The link carries `utm_source=abandoned_cart`, the storefront captures
  it, window 1's placement writes the row.
- Contract surface filed: **#244** (db `0170_cart_recovery.sql` — `cart_recovery` with the per-cart UNIQUE,
  `token_hash`, expiry, `redeemed_at`, plus `marketing_cursor`), **#245** (Admin API report + Store API
  `POST /store/cart-recovery/{token}`), **#246** (window 1 mounts the store route), **#247** (windows 3 and 10,
  the storefront page). Built against `proposed/0170_cart_recovery.sql`, applied by the tests to their own
  database (#162's pattern); both CCs land bundled as contracts-v0.4.5 after this PR merges.
- Tests (+19): `recovery.test.ts` (16) drives **window 1's real `markAllAbandonedCarts`** rather than a
  hand-written payload, so the consumer is exercised against the emitter that runs in production — if window 1
  changes the payload, this fails. Covers consumption, replay, batching, per-store cursors, token storage and
  randomness, single use, the identical-404 set, the 409, recovery detection, the rate and its edges. Plus 3
  route tests for the report.
- Housekeeping: `apps/feeds` docs no longer claim there is no Dockerfile — it landed with infra #210 and #195
  is closed.

### 2026-09-19 · 2.3 Segments, templates and the messaging sync contract (#147)

- `segment-rules.ts`: **the frozen grammar** — `{ v: 1, all: [{ any: [{ field, op, value }] }] }`, an AND of ORs
  over a closed seven-field predicate set. `parseSegmentRules` 400s on any unknown field, operator, extra key or
  wrong value type, naming the exact path (`rules.all[0].any[2].op`). `SEGMENT_RULES_SCHEMA` publishes the same
  grammar as JSON Schema from the module index for window 16 and the admin rule builder; a test runs the parser
  and the schema over the same fixtures so they cannot drift.
- `segment-sql.ts`: rules → one parameterised SQL predicate. Values are always bound, never interpolated (there
  is an injection test). Every predicate is **total** over ragged data — no orders, no address, no
  `metadata.tags`, no consent block all still evaluate. `not_granted` uses `IS DISTINCT FROM`: `NOT (NULL =
'true')` is NULL, which silently dropped never-asked customers from re-consent segments (caught by a test).
- `segments.ts`: CRUD for store segments and organization templates over one table, `previewSegment` (counts,
  writes nothing, accepts override rules from the body), `materializeSegment` (replaces `segment_member` in one
  transaction, updates the counters), template instantiation by copy. Deleting a segment a non-ended campaign
  points at is a 409 rather than letting the FK quietly unlink it.
- `segment-sync.ts`: the window 16 contract — a typed payload and one paged function over the **materialised**
  members, so preview, count and send are the same set. Ids, `email_hash` and granted channels only; no address,
  name or phone ever crosses the boundary. No provider call in this module.
- `segment-types.ts`: `Segment` with `rules` typed as the frozen grammar; the table row; the sort enum.
- 12 new routes: 7 store-scoped (`materialize` answers 202 per the contract) and 5 organization-level for
  templates (`viewer` reads, `owner` writes on `organization:hq`).
- Data-model decisions, checked against the schema rather than the contract's prose: `tags` is
  `customer.metadata.tags` (no `customer.tags` column exists); `country` is the **default shipping address
  only**; `customer_group_ids` is membership-in-list against the single FK; `erased`/`disabled` customers are
  never counted.
- Cleanup now that #181 landed: the local `enumParam` copy in `routes.ts` is gone in favour of `src/http`'s
  exported `enumParam`/`sortParams`, as its comment promised, and the router header no longer says "not mounted".
- CONTRACT CHANGE filed for `SegmentRules` (still the loose flat bag in 0.4.3, with "Unknown keys are kept, not
  rejected" — the opposite of a frozen grammar). Responses validate meanwhile because the document accepts
  additional properties; the manager lands the change after this PR merges.
- Tests (+75): `segment-rules.test.ts` (35, pure — accept/reject per field and operator, parser/schema
  agreement, SQL shape and injection), `segments.test.ts` (20, database — every operator against real orders and
  customers, preview == materialised count, consent exclusion incl. malformed blocks, template RLS and copying,
  store isolation, the sync payload and its paging), and 8 more in `routes.test.ts`. The seed creates no
  customers, so the database tests build their own; keys and names are words, never digit or hex tails.

### 2026-09-08 · 2.2 Product feeds for Google Merchant and Meta (#146)

- `feed-types.ts`: `ProductFeedRow` (table) vs `ProductFeed` (contract), the channel/status enums,
  `RENDERABLE_CHANNELS` and the extension map that is also half the storage key.
- `feed-items.ts`: `buildFeedItems` — one row per priced variant, from `product` / `product_variant` / `price`
  (default active price list, feed currency) / `inventory_level` (active warehouses) / `product_media` /
  `store_domain`. Applies `filters` (category_ids, tags, in_stock_only) and `mapping` overrides (brand,
  description, item_group_id; unknown keys kept, not rejected). Ordered by handle then variant position so the
  output is stable — which is what makes a content hash meaningful.
- `feed-validation.ts`: the Google/Meta required-field lists. A bad row keeps its codes and is still returned by
  `listFeedItems`, is left out of the file, and lands on `product_feed.errors` with its product id. A missing
  GTIN is an advisory (Google warns, not rejects) and does not block the row.
- `feed-render.ts`: Google Merchant RSS 2.0 with the `g:` namespace and Meta CSV (CRLF, RFC-4180 quoting).
  Deterministic by design — no timestamps — plus `formatPrice` honouring the ISO 4217 exponent (JPY, KWD…).
- `storage.ts`: the `FeedStorage` seam (`setFeedStorage`, manager decision 2026-09-08) with
  `FilesystemFeedStorage` as the default and an S3 implementation later; strict key validation on
  `<store_code>/<feed_id>.<ext>`, the convention shared with `apps/feeds`.
- `feeds.ts`: CRUD (currency must be one of the store's; `error` is not an input status) plus `publishFeed` —
  build, validate, render, hash against the stored artifact, store only if changed, update the row, emit
  `feed.published` only if changed. `status` is `error` on a feed-level failure or when every row is rejected;
  an empty catalogue stays `active` with `item_count: 0`. Deleting a feed removes its artifact.
- Seven new routes on `marketingAdminRouter()`.
- `proposed/product-feed.schema.json` + a CONTRACT CHANGE issue: Admin API 0.3.0's `ProductFeed` is
  `allOf[ProductFeedInput, …]` and `ProductFeedInput.status` excludes `error`, so the document rejects the very
  status `publishFeed` documents. `feed-types.ts` carries the corrected read type meanwhile; the error-status
  response is asserted against the proposed schema and every other feed response against the frozen document
  (window 9's `proposed/` pattern from #162).
- Tests (+38): `feed-render.test.ts` (11, pure — price exponents, escaping, determinism, the required-field
  rules), `feeds.test.ts` (14, database — CRUD, row building, filters, mapping, publish, idempotency, the
  no-domain error path, artifact deletion, RLS), and 5 more in `routes.test.ts` for the seven routes and their
  permissions. The feed server has its own 13 in `apps/feeds`.

**Not mounted, not containerised:** the router still needs window 1's mount line (REQUEST #181), and
`apps/feeds` needs a Dockerfile from window 5 (REQUEST filed with this task) —
`infra/ci/check-image-manifests.sh` fails until it lists `apps/feeds/package.json`, which is the intended prompt.

### 2026-09-08 · 2.1 Campaign module with attribution report (#145)

First code in this folder.

- `types.ts`: the contract shapes (`Campaign`, `CampaignInput`, `AttributionReport`, `Money`) re-exported from
  `@platform/contracts`, the enums as runtime arrays (`CAMPAIGN_TYPES`, `CAMPAIGN_STATUSES`,
  `CAMPAIGN_SORT_FIELDS`, `TOUCHES`), the legal transition sets (`LAUNCHABLE`, `ENDABLE`), and `CampaignRow` — the
  table shape of migration 0120, kept deliberately separate from the contract shape.
- `campaigns.ts`: CRUD + `launchCampaign` / `endCampaign` over a store-scoped `ScopedClient`. Every statement
  filters `store_id` explicitly on top of RLS. `createCampaign` always produces a `draft`; `delete` is refused
  with 409 for anything else; an `ended` campaign can no longer be edited (it is what the report reads as
  history). `campaign.launched` / `campaign.ended` are written through `withEvents` in the same transaction as
  the status change; create/update/delete are audited, not evented. A relaunch keeps the first `launched_at`.
- `normaliseCampaignInput` enforces the two table CHECKs (`ends_at >= starts_at`, budget requires a currency) as
  `validation_error`, so the API answers 400 with a field name instead of a Postgres constraint name.
- Budget mapping: contract `Money` ⇄ `budget_minor` + `currency`, in the service only (manager decision
  2026-09-08 — no contract change).
- `reports.ts`: `attributionReport` — `attribution` joined to `"order"` (placed in `[from, to)`, not cancelled),
  grouped by utm source/medium/campaign for one touch model. Campaign linking happens **at report time** by
  case-insensitive `utm_campaign` match within the store, so `attribution.campaign_id` stays NULL as window 1
  writes it and a campaign created later still claims its orders. Orders with no attribution row are reported as
  `direct`, so the totals reconcile with the order list.
- `routes.ts`: `marketingAdminRouter()` — the seven campaign operations plus `getAttributionReport`, built the
  same way as `src/http/admin-routes.ts` (`x-permission` read from `admin-api.yaml` at runtime, bodies validated
  against the operation's `requestBody` schema). `enumParam` is duplicated locally: `src/http/query.ts` has it but
  does not export it through `src/http/index.ts`, and reaching past a folder's public API is what the module
  rules forbid (noted in the REQUEST).
- Not mounted yet: `src/http` and `src/server.ts` are window 1's. The mount line is a `REQUEST:` issue; until it
  lands `routes.test.ts` mounts the router behind the real middleware chain on a bare Express app.
- Tests (23): `marketing.test.ts` — CRUD, transitions and their outbox events, audit rows, tenant isolation
  across brand A/B, and the report (first vs last touch, `direct` orders, case-insensitive campaign linking,
  exclusion of cancelled / out-of-window / other-currency orders). `routes.test.ts` — every operation against the
  spec's components, `store_staff` read vs `store_admin` write vs `viewer` on reports, 400/401/403/404/409 bodies.

**Known limitation:** the report aggregates in the store's default currency and excludes orders in other
currencies (`AttributionReport` has one `currency` and no way to declare a mix). Manager decision 2026-09-08:
keep the exclusion, revisit at Integration 2 when multi-currency orders exist. Documented in README.md.
