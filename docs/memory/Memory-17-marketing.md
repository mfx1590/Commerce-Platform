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
- **2.1 (#145) campaigns + attribution report** — commit `ca83a70`, PR #182 (2026-09-08). New module
  `apps/core/src/modules/marketing/` (types, campaigns, reports, routes, index, README, CHANGELOG) + 23 tests.
  Campaign CRUD, `launch`/`end` with `campaign.launched`/`campaign.ended` through the outbox in the same
  transaction, and `GET .../marketing/reports/attribution` computed from `attribution` joined to `"order"`.
  Router exported from index.ts, **not mounted** — REQUEST #181 to window 1 (mount line + `enumParam` export).
  Gates: lint, typecheck (18/18), format:check, `pnpm test --filter @platform/core` = 190 passed / 1 skipped.

## In progress
- **2.2 (#146) product feeds — code complete and green locally, NOT yet committed/pushed.** Holding until the
  manager confirms #182 (2.1) merged, then `git merge main`, commit, push, open the 2.2 PR.
  Delivered: `apps/core/src/modules/marketing/{feed-types,feed-items,feed-validation,feed-render,storage,feeds}.ts`
  + 7 routes; `apps/feeds/**` (server, storage reader, config, README/CLAUDE/CHANGELOG, 13 tests).
  Gates green: lint, typecheck 19/19, format:check, core 220 passed / 1 skipped, feeds 13 passed.
  `infra/ci/check-image-manifests.sh` is RED on purpose (4 Dockerfiles missing `apps/feeds/package.json`) — the
  intended prompt; REQUEST #195 to window 5. To call out in the PR so it is not read as a regression.

## Next — Phase 2 (GitHub issues; acceptance criteria there are authoritative)
- [x] **#145 · 2.1** Campaign module with attribution report — PR open 2026-09-08
- [~] **#146 · 2.2** Product feeds for Google Merchant and Meta — built and green, PR pending #182's merge
- [ ] **#147 · 2.3** Segments with preview, materialisation and Klaviyo sync contract
- [ ] **#148 · 2.4** Abandoned-cart recovery
- [ ] **#149 · 2.5** Admin Marketing section v1
- [ ] **#150 · 2.6** READMEs, CLAUDE.md, tests green, Phase 3 handoff

## Decisions made (with reasons)
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
- **#182 (2.1) merge confirmation** — no pushes until the manager says it landed; then `git merge main` first.
- **CONTRACT CHANGE #194** — Admin API 0.3.0's `ProductFeed` is `allOf[ProductFeedInput, …]` and
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
