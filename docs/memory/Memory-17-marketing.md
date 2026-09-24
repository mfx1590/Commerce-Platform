# Memory 17 — Marketing
Window: 17 · Key: `marketing` · Branch prefix: `marketing/` · Model: Fable (manager decision 2026-09-08: money and attribution)
Last updated: 2026-09-08 · Contracts: contracts-v0.3 (Store API 0.3.0, Admin API 0.3.0, events 0.2.0, db 0.2.0; tagged at the end of Integration 1) · Branch: `marketing/phase2` · Status: 2.1 in review (PR #182), 2.2 feeds built and green, awaiting the 2.1 merge before pushing

## Identity (does not change)
Owned paths (write):
- `apps/core/src/modules/marketing/**`
- `apps/feeds/**`
- `apps/admin/src/app/(store)/[storeId]/marketing/**`
- `apps/admin/src/app/(hq)/marketing/**`
Reads:
- docs/marketing-scope.md (the scope and decisions)
- packages/contracts (Admin API marketing paths, v0.3)
- packages/events (campaign.*, feed.published, attribution.recorded, referral.converted, review.published, cart.abandoned)
- apps/core/src/modules/{registry,catalog}/index.ts (public APIs only), promotions module public API (window 9)
Never touches:
- packages/*, docs/ (except this file), other modules' internals, messaging delivery (window 16), CMS (window 6)

## Mission — Phase 2 (Commerce complete, brand 1 live)
Make marketing a product, not a side effect: campaigns with server-side attribution, product feeds for Google Merchant and Meta per brand, segments with a rule builder synced to the messaging provider, abandoned-cart recovery, and the Marketing section of the admin (Store view). Every number reported comes from events and orders in the core, never from a pixel. Wave B — starts when core 2.1–2.2 have merged; marketing may start against the mocks as soon as contracts-v0.3 is tagged.

## Done
- **contracts-v0.4.5 cleanup** — 2026-09-24. The landing (0eafbc9) had already moved `0170_cart_recovery.sql`
  into `packages/db/migrations` and dropped the test DDL, so this covered the rest: the local
  `AbandonedCartReport` type → the contract's, `permissionOrProposed` → plain `permission()`, the #251 cast in
  the admin `_api.ts` → `AdminResponse<'materializeSegment'>` (window 4's 202 branch merged as 1f21588), the
  abandoned-cart tile on the admin Overview, and the three #250 nits — report consistency (cancelled orders
  excluded from `recovered_count` as well as `recovered_value`, with a test), `RECOVERY_UTM_SOURCE` exported
  for window 16, and `tokenHashEquals` deleted.

- **2.5 (#149) admin Marketing section** — 2026-09-20. Four Store screens + the HQ page, in
  `apps/admin/src/app/(store)/[storeId]/marketing/**` and `(hq)/marketing/**`; wrappers and server actions in
  the section (window 4's files untouched); rule builder over the frozen grammar with a live preview count.
  Tests: 9 pure + 8 Prism contract (every field/op posted as a `SegmentInput`). REQUEST #251 filed (202 branch
  missing from window 4's `SuccessBody`). Section README documents the boundary.

- **2.4 (#148) abandoned-cart recovery** — commit `d8187ba`, PR #250 (2026-09-19), pushed after #240's merge
  is confirmed. `recovery{,-token,-report,-types}.ts` + the report route. Outbox polling per store with the
  cursor in `marketing_cursor`; idempotency is `UNIQUE (cart_id)` in the schema, not consumer memory. Tokens:
  32 random bytes, sha256-only storage, single use via `UPDATE … WHERE redeemed_at IS NULL`, 7-day expiry, one
  404 for unknown/expired/used and 409 for an already-ordered cart. Tests drive **window 1's real
  `markAllAbandonedCarts`**, not a fixture payload. Filed #244 (db 0170), #245 (Admin report + Store API
  recover), #246 (window 1 mounts the route), #247 (windows 3/10 storefront page).

- **2.3 (#147) segments** — commit `ae09724`, PR #240 (2026-09-19). Frozen rule grammar
  `{ v:1, all:[{ any:[{field,op,value}] }] }` over a closed 7-field set, 400 on anything else naming the exact
  path; `SEGMENT_RULES_SCHEMA` published from index.ts for window 16 + the admin, with a test running parser and
  schema over the same fixtures. `segment-sql.ts` compiles rules to one parameterised predicate, total over
  ragged data. CRUD + preview + materialise (202) + organization templates (copy-at-creation) + the window 16
  sync payload (ids and `email_hash`, no provider call). 12 new routes. CONTRACT CHANGE #239 filed.
  Also deleted the local `enumParam` copy now that #181 exports `enumParam`/`sortParams`.

- **2.2 (#146) product feeds** — commit `c787e41`, merged main in `47608e3`, PR #200 (2026-09-09).
  Core: `feed-types/feed-items/feed-validation/feed-render/storage/feeds.ts` + 7 routes on the same router.
  New app `apps/feeds` (Node `http`, no runtime deps, serves artifacts only).
  Publish = build → validate → render → store; idempotent on the **stored artifact's** hash, so identical bytes
  write nothing and emit nothing. Renderers deterministic (no timestamps) — that is what makes the hash work.
  Found and filed CONTRACT CHANGE #194 (accepted → Admin API 0.4.1 after #200 merges); REQUEST #195 to window 5.

- **2.1 (#145) campaigns + attribution report** — commit `ca83a70`, PR #182 (2026-09-08). New module
  `apps/core/src/modules/marketing/` (types, campaigns, reports, routes, index, README, CHANGELOG) + 23 tests.
  Campaign CRUD, `launch`/`end` with `campaign.launched`/`campaign.ended` through the outbox in the same
  transaction, and `GET .../marketing/reports/attribution` computed from `attribution` joined to `"order"`.
  Router exported from index.ts, **not mounted** — REQUEST #181 to window 1 (mount line + `enumParam` export).
  Gates: lint, typecheck (18/18), format:check, `pnpm test --filter @platform/core` = 190 passed / 1 skipped.

## In progress
- (nothing — 2.5 is PR #262 and the 0.4.5 cleanup is done; 2.6 docs (#150) is the last task)

## Next — Phase 2 (GitHub issues; acceptance criteria there are authoritative)
- [x] **#145 · 2.1** Campaign module with attribution report — PR open 2026-09-08
- [x] **#146 · 2.2** Product feeds for Google Merchant and Meta — PR #200 in review
- [x] **#147 · 2.3** Segments with preview, materialisation and Klaviyo sync contract — PR #240 in review
- [x] **#148 · 2.4** Abandoned-cart recovery — PR #250 in review
- [x] **#149 · 2.5** Admin Marketing section v1 — PR #262 in review
- [ ] **#150 · 2.6** READMEs, CLAUDE.md, tests green, Phase 3 handoff

## Decisions made (with reasons)
- 2026-09-20 (manager, 2.5) · The analyst's marketing Overview is the **HQ** page, not the store one. The
  store section is gated on `store_staff` — authoring work an analyst has no relation for — and the scope doc
  already puts the cross-brand dashboard at organization level. Window 4's `sections.ts` stays untouched.
- 2026-09-20 (me, 2.5) · The rule builder's contract proof is a **Prism contract test**, not ajv in the admin:
  posting `toRules(draft)` as a `SegmentInput` makes the spec itself the validator, so no copy of the grammar
  lives in the admin and no new dependency lands in window 4's package.
- 2026-09-20 (me, 2.5) · The abandoned-cart tile is omitted until 0.4.5 rather than built on an untyped fetch.
  A tile that might be wrong is worse than a tile that is missing.
- 2026-09-19 (manager, 2.4) · Redemption is a **Store API route in the core**, not an exported function the
  storefront calls. The token deliberately carries no cart id, so only a server round trip can resolve it, and
  window 3's app speaks nothing but the publishable-key Store API. My own lean to the exported function was
  wrong for exactly that reason. → `validateRecoveryToken` + REQUEST #246.
- 2026-09-19 (manager, 2.4) · Unique-per-cart is the replay guard; sha256-only token storage, single use,
  7-day expiry, nothing identifying inside the token; this module writes no attribution.
- 2026-09-19 (me, 2.4) · `expired` is **not** a stored status — it is `pending AND token_expires_at < now()`.
  A status column that needs a cron to stay honest is a bug waiting for an outage.
- 2026-09-19 (me, 2.4) · The report's `recovered_value` is the **order** total, not the cart total: what the
  customer actually paid after coming back is the number anyone weighing recovery against its cost wants.
- 2026-09-19 (manager, 2.3) · Rule grammar is `{ v:1, all:[{ any:[predicate…] }…] }` — AND of ORs, **closed**
  predicate set, **400 on any unknown predicate**, and the module publishes both the TypeScript type and a JSON
  Schema from index.ts. Reason: a segment that silently ignores a rule it does not understand sends the wrong
  campaign to the wrong people and nobody finds out.
- 2026-09-19 (manager, 2.3) · `tags` = `customer.metadata.tags`; a missing key or non-array value is "no tags",
  never an evaluation error — metadata is free-form and the grammar must be total over real rows.
- 2026-09-19 (manager, 2.3) · `country` = the **default shipping address only**. Segments must be deterministic
  and reflect who the customer is today; a stale secondary address must not pull someone into a geo campaign.
  "Any address ever" would be a separate additive predicate (`country_any`) later — explicitly not built now.
- 2026-09-19 (me, 2.3) · `template_id` copies rules **at creation** and is history, not a live link: editing a
  template must never silently change who a live campaign reaches, and deleting it must not break the segment.
- 2026-09-19 (me, 2.3) · The sync payload reads `segment_member`, not the rules, so preview, count and send are
  the same set; re-evaluating at send time would let the audience drift from the count that was approved.
- 2026-09-08 (manager, 2.2) · **The core renders and stores feed files; `apps/feeds` only serves them.** A core
  module and an app cannot import each other, so the writers live in exactly one place. Chose the core because
  the publish job needs bytes to hash for idempotency, and because the process on the public URL then has no
  database at all. Cost: ~25 duplicated lines of filesystem read in the app plus a shared key convention
  `<store_code>/<feed_id>.<ext>`, documented in both READMEs.
- 2026-09-08 (manager, 2.2) · `FeedStorage` seam: local filesystem now, S3-style later (window 5 provisions the
  bucket, REQUEST #195). The app serves only its own store-code prefix (`FEEDS_STORE_CODES`, production refuses
  to boot without it) and **never lists** the store.
- 2026-09-08 (manager, 2.2) · Idempotency per content hash stays in the core: identical bytes write no artifact
  and emit no `feed.published`. Consequence I chose and documented: `last_published_at` means "when the file last
  changed"; `status`/`url`/`item_count`/`errors` still refresh on every run so the admin never sees a stale verdict.
- 2026-09-08 (me, 2.2) · Both renderers are deterministic — no timestamps, no generated ids, stable ordering.
  A `lastBuildDate` element would make every publish look like a change and defeat the hash entirely.
- 2026-09-08 (me, 2.2) · A row failing validation is reported (item `errors` + `product_feed.errors` with the
  product id) and kept out of the file; a missing GTIN is an advisory that does not block the row. `item_count`
  counts what was actually written.
- 2026-09-08 (manager, on my 2.1 plan) · `budget` maps between the contract's `Money` object and the table's
  `budget_minor` + `currency` **in the service**; no contract change. Reason: the mismatch is presentational.
- 2026-09-08 (manager, on my 2.1 plan) · The attribution report aggregates in the store's **default currency** and
  **excludes** orders in any other currency; the exclusion is documented in the module README, no `mixed_currency`
  flag. Reason: `AttributionReport` carries one `currency` and no way to declare a mix; multi-currency orders do
  not exist yet. **Revisit at Integration 2** when they do — this is the one place marketing knowingly under-reports.
- 2026-09-08 (me, 2.1) · Campaign linking happens at **report time** (case-insensitive `utm_campaign` match within
  the store), not at placement. Reason: `src/lib/attribution.ts` writes `campaign_id` NULL by design, so a campaign
  created or renamed after the orders arrived still claims them and no attribution row is ever rewritten.
- 2026-09-08 (me, 2.1) · `ended` is a final status: an ended campaign cannot be edited or deleted. Reason: the
  report reads it as history; changing its `utm_campaign` would silently move which orders belong to it.
- 2026-09-05 (manager) · Campaigns/feeds/reviews/referrals are store-level; segment templates and the dashboard are organization-level — same tenancy model as the core.
- 2026-09-05 (manager) · Attribution is server-side from UTM/referrer captured on the cart (window 3 does the capture in Phase 1); pixels are optional extras, never the source of reported numbers.
- 2026-09-05 (manager) · Marketing never mutates orders, prices or stock; it reads events and writes its own tables.

## Blocked / waiting
- **#240 (2.3) merged** 2026-09-19 (4ea4abb); contracts-v0.4.4 tagged (5f79e6d), #239 landed in it. One
  landing-commit change in my files: routes.test.ts grammar-400 now asserts the spec-layer rejection
  (validateBody refuses before my parser, AJV dotted paths); parser tests untouched. Carried through and green.
- **#244 / #245** (db 0170 + Admin/Store API) land bundled as **contracts-v0.4.5** after the 2.4 PR merges.
  Building against `proposed/0170_cart_recovery.sql`; the report route falls back to the proposed `viewer`
  permission only while the operation is absent from the spec. **Correction posted on #244**: drop
  `CHECK (redeemed_at >= created_at)` — see Gotchas.
- **#246** window 1 mounts `POST /store/cart-recovery/{token}`; **#247** windows 3/10 build the page. Neither
  blocks the module.
- **CONTRACT CHANGE #239 (SegmentRules)** — filed 2026-09-19, manager lands it after the 2.3 PR merges (the
  0140/0160 pattern). No `proposed/` copy needed: responses validate against the frozen document today because
  it still accepts additional properties. A route test asserts the **old flat shape is refused**, which is the
  behaviour #239 documents.
- **Local Docker stack is DOWN (2026-09-09)** — Docker Desktop is not running on this machine, so every suite
  calling `createTestDatabase` fails with `ECONNREFUSED :5433` (window 9's search suites too, not just mine).
  Lint/typecheck/format still run. Restarting the shared stack is the manager's call at a quiet moment
  (stack etiquette): do not `pnpm dev --reset` or recreate containers. Stated as a caveat on PR #200.
- **CONTRACT CHANGE #194 — ACCEPTED** (manager 2026-09-09): `ProductFeed` gets its own status enum including
  `error` and `ProductFeedInput` stops carrying `status`; lands as **Admin API 0.4.1 after PR #200 merges**.
  Keep `proposed/` and the loud inverted test until then, then delete both in a follow-up.
  Original report: Admin API 0.3.0's `ProductFeed` is `allOf[ProductFeedInput, …]` and
  `ProductFeedInput.status` excludes `error`, so the document rejects the status `publishFeed` produces and the
  generated type will not compile with it. Working against `proposed/product-feed.schema.json` + a local read
  type; a test asserts the frozen document *still rejects* the error response, so it fails loudly when #194
  lands and tells me to delete the workaround.
- **REQUEST #195 (window 5)** — `apps/feeds/Dockerfile`, `apps/feeds/package.json` in all four images' deps
  stages (image-manifests guard is red until then, by design), and the artifact bucket to plan.
- **REQUEST #181 (window 1)** — the one line that mounts `marketingAdminRouter()` in `src/http`, plus exporting
  `enumParam`/`sortParams` from `src/http/index.ts` (I carry a local copy of `enumParam` until then). Not blocking:
  `routes.test.ts` mounts the router behind the real middleware chain, so the contract shapes are proven. Delete
  the local copy in a follow-up once it lands.
- 2.2 feeds will need a **REQUEST to window 5** with the first `apps/feeds` PR: `infra/ci/check-image-manifests.sh`
  fails the build as soon as `apps/feeds` exists until every Dockerfile's deps stage lists it (intended prompt).

## Gotchas learned
- **Docker Desktop flaps on this machine.** Two distinct failures, both environmental, neither a code problem:
  (1) `localhost` resolves to `::1` and the IPv6 port proxy dies — pin `DATABASE_URL*` to **127.0.0.1**;
  (2) Docker Desktop itself restarts mid-run, and a 63-file core suite is long enough to be caught by it
  (37 files "failed", all connection errors; the same suite then passed 726/726 once it stayed up). Before
  reporting a red core suite, check `docker ps` answers at all and re-run.
- **`turbo` strips `DATABASE_URL*`**, so `pnpm test --filter @platform/core` does not see an exported override.
  Run `pnpm --filter @platform/core exec vitest run` directly when you need the pinned host.
- 2.5: window 4's `SuccessBody` maps 200 → 201 → `null`, so **a 202-with-body types as `null` silently** —
  no error, the call site just gets nothing. Hit `materializeSegment`; window 13's `eraseCustomer` is the other
  one. REQUEST #251.
- 2.5: `useContractForm` returns `{ form, submit, formError, refusal, isSubmitting }` — field errors are
  `form.formState.errors.x` through `errorMessage()`, and `SelectField` takes `options`, not children.
- 2.5: the admin's unit vitest only includes `test/**`, so tests for anything under `src/app/**` must live in
  `apps/admin/test/` — which is why the ownership row needed extending before 2.5 could be finished.
- 2.5: `me.data.stores[].store_id`, not `.id`, is the store key on the principal.
- 2.4: **never CHECK an app-supplied timestamp against a database-generated one.**
  `CHECK (redeemed_at >= created_at)` with `created_at DEFAULT now()` compares the Postgres clock to the Node
  clock and fails on ordinary skew. Four tests passed in isolation and failed in the full run; corrected on
  #244 before the migration landed.
- 2.4: the schema's `app.set_updated_at` trigger fires BEFORE UPDATE, so **you cannot back-date a row with an
  UPDATE** — it stamps `now()` over your value. Set the timestamp in the INSERT and never touch the row again;
  this is why window 1's abandoned-cart job found nothing at first.
- 2.4: `cart.order_id` is a FK onto `"order"`, so test cleanup must null it before deleting orders.
- 2.4: single use must be `UPDATE … WHERE redeemed_at IS NULL`, not check-then-write — two clicks arriving
  together would otherwise both succeed.
- 2.3: **`NOT (NULL = x)` is NULL, not true.** `consent not_granted` written as `NOT (… = 'true')` silently
  dropped every customer with no consent block — exactly the people a re-consent campaign targets. Use
  `IS DISTINCT FROM`. Any negated predicate over a nullable column needs the same treatment; a test caught it.
- 2.3: RLS kind `store_nullable` = organization rows (`store_id IS NULL`) are visible **only** when
  `app.current_scope() = 'organization'`. A tenant client cannot read a template even by id, so copying one
  needs an organization-scoped client — and `organizationClientFor(principal)` refuses a store_admin (no HQ
  relations), so the client is injected into the service instead.
- 2.3: a service that builds a client from `lib/db`'s process-global pool cannot be tested without `initDb()`.
  Inject the client and default to the global one; three tests failed on this before the seam went in.
- 2.3: the seed creates **no customers** — DB tests for anything customer-shaped build their own fixtures.
- 2.3: `#181` landed, so `src/http` now exports `enumParam`/`sortParams`; the local copies are gone.
- 2.2: `apps/feeds` is ESM (`"type": "module"`) under `nodenext`, so **relative imports need the `.js`
  extension** (`./server.js`) even in TypeScript. The core does not, because it is CommonJS — do not copy its
  import style into a new app.
- 2.2: an OpenAPI `allOf` that *overrides* an enum does not widen it, it **intersects** it. That is how #194
  slipped through review: the document reads as if `error` is allowed and neither ajv nor tsc agrees. Check any
  `allOf[XInput, {...}]` pair where both branches declare the same property.
- 2.2: root `lint` runs `no-console` with only `warn`/`error`/`info` allowed — `console.log` in a new app fails
  the gate at `--max-warnings 0`.
- 2.2: a feed file must contain **no timestamp** or content-hash idempotency is worthless. Same trap for any
  future generated artifact.
- 2.2: bigint/`sum()` from node-postgres are strings; `count(*)::int` is a number (also hit in 2.1).
- 2.1: `src/http/index.ts` does **not** export `enumParam` / `sortParams` even though `src/http/query.ts` has them
  (asked for in #181). Do not import `../../http/query` to get at them — that is exactly the public-API rule the
  module layout forbids; copy the few lines with a pointer to the issue instead.
- 2.1: the contract's `Campaign` and the `campaign` table disagree on shape in one place (`Money` vs two columns).
  Keep `CampaignRow` and `Campaign` as separate types and translate in exactly one function (`toCampaign`);
  the same split will be needed for `product_feed` (2.2) and `segment` (2.3).
- 2.1: event payload optional fields are `$ref`s to the uuid/timestamp/money definitions, which do **not** accept
  null — omit them (`...(x ? { x } : {})`) or `withEvents` throws and aborts the whole transaction.
- 2.1: bigint columns (`budget_minor`, `total_minor`) come back from node-postgres as **strings**; `count(*)::int`
  is a number but `sum(...)` is not. Cast in SQL (`::text`) and `Number()` in TypeScript, deliberately.
- 2.1: the seed has no orders. Report tests insert into `"order"` directly (owner client, `sales_channel_id` looked
  up per store) — marketing never writes orders anyway, so nothing is being faked that the module would own.
- Integration 1 (2026-09-08): real Keycloak staff tokens are the default on the core's Admin API; `CORE_DEV_TOKENS=1` keeps `Bearer dev:<subject>` working locally. The storefront can run against the core with `STORE_API_URL=http://localhost:9000` (+ `CORE_STORE_API_FALLBACK=1` + `CORE_STORE_API_FALLBACK_URL=http://localhost:4010` on the core so unimplemented Store routes still answer from Prism). The admin uses `ADMIN_API_URL`.

## How to run & test this package
```
pnpm --filter @platform/core exec vitest run src/modules/marketing   # fast loop (~15 s, own throwaway DB)
pnpm --filter @platform/feeds test                                   # the feed server, no DB at all (~2 s)
pnpm lint && pnpm typecheck && pnpm test --filter @platform/core     # the gates, before every PR
pnpm exec prettier --write apps/core/src/modules/marketing/          # format:check is part of CI
```
Tests build their own database through `@platform/db/testing` + `seed` — they never touch the shared docker stack.
Route tests use `CORE_DEV_TOKENS=1` with the seeded subjects (`seed-store-admin`, `seed-store-staff`, `seed-analyst`).

## Later phases (do not start until Memory-main says so)
### Phase 3 — Multi-store & HQ
- [ ] Referral programme (codes, landing `/r/{code}` with window 3, rewards via promotions, `referral.converted`)
- [ ] Reviews: submission after `shipment.delivered` (request e-mail via window 16), moderation queue, PDP display contract with window 3
- [ ] Consent centre: per-channel opt-in rates, double opt-in for EU brands, export for audits
- [ ] HQ marketing dashboard: per-brand comparison, shared segment templates, budgets per legal entity (feeds window 15 a spend line)
### Phase 5 — Data platform & AI
- [ ] Loyalty (Talon.One or in-house) on top of segments + referral
- [ ] Marketing marts with window 12: campaign ROI, cohort LTV, channel mix
- [ ] AI: product copy for feeds and campaigns, segment suggestions (Claude API)
