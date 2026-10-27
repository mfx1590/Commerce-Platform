# Memory 12 — Data platform, BI & AI
Window: 12 · Key: `data` · Branch prefix: `data/` · Branch: `data/phase5` (from main cadaeba, 2026-10-25)
Last updated: 2026-10-25 · Model: Opus 5.5 · Status: Phase 5 wave 1 — #600 ingest built, PR next; #601 models after it

## PHASE 5 DOCKET (written by the manager, 2026-10-25, Manager session nine) — READ THIS FIRST ON RESUME
Phase 3 reporting v1 is done (#478–#480). Phase 5 = data platform and AI; you are its main window. Plan and the
decisions you must follow: `docs/plan/phase5-plan.md` (D1–D12); tracking #612. New branch `data/phase5` from main.
ClickHouse SQL goes under `data/clickhouse/**` (already inside `data/**`). ClickHouse runs
in the shared compose stack: HTTP 18123, native 19000. Run `fga:seed` before any auth or live test.
- Wave 1: **#600** P5.1 ingest (every topic → `raw_events`, exactly once, DLQ, `--once`), then **#601** P5.2 models
  (staging/facts/marts + `mv_orders_minute`, Vitest on the #552 generated month).
- Wave 2: **#602** reconcile (three identities: bookings / recognised revenue / cash; check 2 uses the LEDGER's posted lines, never a recomputation — D7 as amended 10-25; the CI generated month is the primary proof), **#603** metrics
  API (CONTRACT CHANGE, scope added on the server, no SQL input), **#604** admin BI v2.
- Wave 3: **#606** BI Q&A by tool use over the metrics API, on window 14's **#605** `packages/ai` gateway (moved to 14 on 10-25 to spread the load).
Rules that bite: no dbt/Dagster/Metabase (D3, D5); money in minor units, never summed across currencies; no PII in
ClickHouse; one window measures at a time (ask the manager for the machine); a new required-CI step needs three
consecutive green runs on one head. Message the manager when a PR is up and when checks finish.

## Identity (does not change)
Owned paths (write), per docs/ownership.md row `data/`:
- `data/**`
- `apps/analytics-ingest/**`
- `apps/core/src/modules/reporting/**`
- `apps/admin/src/app/(hq)/bi/**`
- `apps/admin/test/bi/**`, `apps/admin/test-contract/bi/**`, `apps/admin/e2e/bi/**` (manager decision 2026-10-18; the
  row lands on main before the #480 PR is pushed)
Route mounting = REQUEST to window 1 (`src/http/module-routers.ts`); admin rail, shell, `apps/admin/src/lib/**`, the
section catalogue, apps/admin README/CHANGELOG = window 4. apps/core CHANGELOG and `src/http/**` = window 1.
Migrations, contracts, events, docs (except this file) = main window via `CONTRACT CHANGE:`.
Manager: "Manager session nine" (local_7d042551-aad2-4845-9b2e-e0ad20f9e01e) since 2026-10-25; seven and eight
retired. Plan before building, report PR up (number + head sha), report checks done.

## Mission — Phase 3 (reporting v1, manager decision 2026-10-16: option C)
security_invoker views read through the tenant-scoped client → Admin API report operations under existing OpenFGA
checks → admin `(hq)/bi` section. NO Metabase in v1 (12.4 sandbox deferred until the owner asks).
- 12.1 #478 views + reconciliation tests · 12.2 #479 Admin API report operations · 12.3 #480 BI section.

## Done
- 12.1 #478: MERGED with integration PR #490 = 63989d4 (my 1829684, 81ca1c3, d99fa3e; manager 941eaaa lands 0200,
  db 0.3.8; #478, #485 closed; PR 486 marked merged).
- 12.2 #479: MERGED with integration PR #500 = d95c64e, tagged contracts-v0.4.22 (my PR 495 head 740ecbe + cleanup
  ff05ec8; manager 2c35abc lands CONTRACT CHANGE #493 as Admin API 0.4.19; window 1 mount 1e93817, REQUEST #494;
  #479 #493 #494 closed; PR 495 marked merged).
- 12.3 #480: PR #502 (code commits 16517a5 + 5e6a214; head = this memory commit on top of a8a8525, the merge of
  main e930aa3). `(hq)/bi` page + `_api.ts` + `_lib/report.ts`
  + `_components/{bi-report,series-chart}.tsx` + README; `apps/admin/test/bi/{report,bi-page}.test.ts(x)` (32),
  `apps/admin/test-contract/bi/bi.test.ts` (4, Prism); core: analyst reads a store's stock test,
  REFUND_REASONS.includes.
- P5.1 #600: MERGED with integration PR #618 = 9e8993d (my PR #616: code 0949769 + memory 1dba221; manager CI
  commit cea626b adds ClickHouse to the live job and the pinned step "analytics ingest live block — and it really ran";
  3 green runs; Opus review MERGE; #600 closed, #616 marked merged). Dev-stack proof: 460 outbox rows = 460 raw_events
  FINAL per topic, 0 dead letters, replay unchanged.

## In progress — Phase 5
- #601 P5.2 models: PR #619 (Closes #601; code commits 0b3b265, 0a0d6b8, a6b8e42 on top of the merge of main 05cf71f;
  head = this memory commit). Review = a FABLE review after the weekly reset (2026-10-27 14:00 UTC); the manager pins
  the 11 models.test titles in the CI live step on the integration landing. Push NOTHING more unless the review asks.
- WAVE 2 ON (manager 2026-10-27): keep building on data/phase5; the next PR carries the #601 commits until #619 merges.
- #603: CONTRACT CHANGE POSTED 2026-10-27 (issue comment 6438446364): listMetrics GET /admin/metrics + queryMetrics
  POST /admin/metrics/query, both `viewer` on `store:*` (ListObjects scope = today's store-report access);
  finance metrics need `finance` on organization:hq; store_id outside scope → 403; new 503 `unavailable`
  response + ERROR_CODE; schemas MetricId/Dimension/Grain/Definition/Catalogue/Query/Row/Result. Checked on a
  reverted working copy: redocly +0 errors; contracts tests fail only on the op count 135 → 137 (4 asserts).
  Open: keep new/returning customers (needs a hashed customer key in fct_order) or drop. Waiting for the decision.
- #602: test-architecture plan SENT 2026-10-27 (one gate test, real relay feeding both consumers; ledger via the
  public createLedgerConsumer + the Finance API in-process with the verifier seam; checks 2a/2b/2c; cash vs
  getHqFinanceReport + PSP clearing + listPayouts; bookings vs getHqSalesReport). GAP: the rpt_* views need core
  order/payment rows the month lacks → asked for `writeMonthToCoreDb` in test-utils (REQUEST) or dev-only bookings.
  NO #602 code until the answer.
- MANAGER DECISIONS 2026-10-27: (A) #603 contract ACCEPTED as posted; KEEP new/returning customers keyed by
  order.placed `email_hash` (an additive fct_order column no operation returns), ERASURE-AWARE from the start (an
  erased customer's key → NULL → counted 'unknown'). The manager lands the contract on integration/phase5-metrics
  after the reset (Fable review); build the compiler + server against the posted YAML LOCALLY, push no contract file.
  NEW #623 (P5.12, mine): ClickHouse must honour customer.erased (raw payloads keep email_hash/customer_id) —
  launch blocker, schedule right after #602.
  (B) #602 architecture ACCEPTED. I write `writeMonthToCoreDb` in packages/test-utils on branch
  `integration/phase5-reconcile` (cut from data/phase5; integration/* may write anywhere): a PURE projection
  (payload → order/payment/refund rows + cancellation status, no business rule, no derived amount), owner pool into a
  THROWAWAY core DB only (refuse unless current_database() is a throwaway, the #595 guard), its own test (projected
  month → the core's report functions = event counts and sums). One PR for #602 + projection, Fable-reviewed. Ask for
  the machine before the gate's live run.
- #602 PROGRESS (branch integration/phase5-reconcile, local commit 593cabf, NOT pushed): writeMonthToCoreDb
  (test-utils, 6/6 green vs the rpt_* views); migration 0003 ledger_lines + model fct_ledger_line; reconcile library
  (clients, diff, identities 1/2a/2b/2c/3a/3b/3c, run, reconcile-cli), 58 unit tests green. NEXT: the gate test.
  ASKED the manager (2026-10-27): put the gate in apps/core/src/modules/reporting/reconcile-gate.test.ts (core HTTP
  in-process via mountCoreMiddleware + dev tokens, core's relay CLI, @platform/accounting Finance API with the
  verifier seam), which adds 3 devDependencies to window 1's apps/core/package.json — apps/core has no package
  exports, so nothing outside it can mount its report routes. APPROVED (manager 2026-10-27) with conditions:
  devDeps only as a separate commit (71f0488, subject "core (window 1 path, integration exception): …", list it in
  the PR body); one-way edge (checked: nothing imports core; prod deploy unaffected; image manifests ok); live job
  only via probe + require-live-tests; dev tokens for core, verifier seam for Finance; run the core FULL suite once.
- Gate written: 40941b2 apps/core/src/modules/reporting/reconcile-gate.test.ts (title 'Integration 5 gate: the
  generated month through the real relay, ledger and ingest, every identity at 0'; 3 tests incl. "fails when it
  should"); outbox via withEvents (core lint forbids raw outbox INSERTs). Docs committed.
- #602: PR #628 (Closes #602; branch integration/phase5-reconcile; code commits 593cabf, 71f0488, 40941b2, 5cbb473,
  1710359 + the merge of main; head = this memory commit). Live with the machine (2026-10-27): TZ=UTC gate 3/3,
  TWICE in a row, every identity 0 (bookings 69 keys, 2a 750 + 33, 2b 282, 2c 97, 3a 73, 3b 73, 3c 0 — no payouts
  in the month); fails-when-it-should green; ~33 s; cleanup 0/0/0/0; core full suite 1175 passed + onboarding
  (beforeAll DB-creation timeout under load, 11/11 alone). Machine free reported. The manager adds the CI step
  (require-live-tests, the gate title) on top of the head and collects 3 green runs; Fable review.
- The first live runs found: LowCardinality(UInt8) from `IN` on a LowCardinality column (cast to String); output
  aliases shadowing WHERE columns (renamed out_*); 3b must compare the capture ENTRY size (1100 is net of the fee —
  comparing it alone copies the fee rule); and REAL BUG #627 (window 15): the Finance API serves dates a day early in
  a non-UTC process (queries.ts date() = toISOString on a local-midnight Date). Run the gate with TZ=UTC until then.
- #628 now carries #601 + #602 (#619 absorbed); the manager's CI commit b128717 is on integration/phase5-reconcile
  (models.test both describes + the gate, TZ=UTC); he collects 3 green runs. PUSH NOTHING to that branch.
- #623 IN PROGRESS on `data/phase5-erasure` (cut --no-track from b128717; local commits only): src/erasure.ts (HMAC
  digest index under ANALYTICS_ERASURE_KEY, scrub at classify, applyErasure = record → flush → re-insert scrubbed →
  DELETE older versions, before the commit), migration 0004 customer_erasures, fct_order.customer_key +
  mart_customers_daily (new/returning/unknown), createIngest `erasure: { key, ch }` (main requires the key; a
  customer.erased batch never commits without a handler), live.test + the gate pass the erasure option,
  erasure.test.ts (5 unit green; 2 ClickHouse tests NOT YET RUN). Design sent to the manager (2026-10-27, veto window);
  REQUEST pending: an .env.example row ANALYTICS_ERASURE_KEY (dev word). Then the #603 build.
- #623 design ACCEPTED (manager 2026-10-27) with amendments, all built in fc43596 (local): A no identifier in SQL
  text (query_params, then event ids) + log_queries=0 on every erasure statement + a query_log/query_views_log/
  processes sweep test; B OPTIMIZE TABLE raw_events PARTITION ID '<p>' FINAL for affected partitions + the sweep reads
  with apply_deleted_mask=0; C index.add and the flush start in ONE synchronous tick + a 15-seed cross-partition
  interleaving test; D the manager lands ANALYTICS_ERASURE_KEY=dev-only-analytics-erasure-key in .env.example + CI;
  rotation documented (rebuild from the core OUTBOX via outbox:replay --topic customer.erased: the bus keeps
  customer.* only 30 days); always fail closed; E bus retention = #629 (window 14 + lawyer list).
  NEXT: the live run (erasure.test 4 ClickHouse tests + models + live + gate) once window 15 frees the machine.
- #623 LIVE (manager's machine, 2026-10-27): the first run found a DATA-LOSS bug — applyErasure's re-read used
  `toString(event_id) AS event_id`, which shadowed the column in `WHERE event_id IN (…)` (the 3rd alias-shadow of
  this phase), so nothing was re-inserted and the DELETE removed the erased customer's orders. Fixed (raw columns,
  no aliases) + a GUARD: never DELETE unless every matched event was read back and re-inserted scrubbed. Also:
  customer events' envelope aggregate_id IS the customer id → scrubbed too (scrubAggregateId); processes check
  excludes queryID(); mart_customers_daily count columns allowed in the PII-name test. Then: erasure 9 + models 11
  + live 4 = 24/24 TWICE, gate 3/3 every identity 0, cleanup 0/0/0/0, root lint/typecheck/prettier green.
- Gotchas: the Finance API `to` is INCLUSIVE, the Admin API report `to` EXCLUSIVE (clients translate);
  getHqFinanceReport has no day dimension (3a asks one day at a time); the order display_id trigger numbers
  display_id 0 (a generated month's display ids collide per store).
- Gotcha repeated: `String.replace(x, str)` expands `$'` / `$&` in the replacement (a YAML pattern `'^[A-Z]{3}$'` did it);
  always pass a function: `replace(x, () => str)`.
- Machine: last runs 2026-10-25, 15/15 three times on the merged head; machine free reported.

## #601 notes (2026-10-25)
- Local branch has #617 (origin/integration/phase5-month-fixture) merged in, to code against `@platform/test-utils`.
- Built: `data/clickhouse/migrations/0002_orders_minute.sql` (orders_minute_events RMT + mv_orders_minute + backfill),
  `data/clickhouse/models/{100_staging,200_dims,300_facts,400_marts,500_live}.sql`; runner → `src/migrations.ts`
  (models re-applied on change, idempotency lint, `_migrations_lock`); InsertRejectedError (follow-up 2);
  `createChReader`; `src/models.test.ts` (9 tests, opt-in) + `src/testing/clickhouse-gate.ts`; READMEs, CHANGELOG 0.3.0.
- 49 unit tests green. With the manager's machine (2026-10-25): models.test 11 + live.test 4 = 15/15 green, THREE
  consecutive runs, 0 leftover databases/topics. The first run found a real bug (mart_cash_daily: output alias
  fee_minor shadowed the source column inside countIf → "aggregate inside aggregate"; fixed with a renaming
  subquery). Manager's two checks added: backfill racing the MV; two runners at once (lock).
- models.test TITLES ARE FROZEN (the manager pins them in CI when #601 lands): describes "ClickHouse models on the
  generated month" and "ClickHouse runner under concurrency", 11 its as in the file. Never rename them.
- check-ownership flags packages/test-utils/src/index.ts ONLY because #617 is merged locally; clears once #617 is
  on main and main is merged.
- PR body must state: the bookings/cash marts are tested against references computed from the events (Postgres =
  ClickHouse is #602's); the live-tile choice (RMT per event + FINAL read, uniqExact); follow-ups 2 and 4 done;
  follow-ups 3 (memory bound doc) and 5 (ch:migrate via tsx in prod image) are later notes.

## #601 design draft (2026-10-25)
- Sources checked: order.placed v1 line_items carry order_line_item_id, variant_id (nullable), sku, title, quantity,
  unit_price_minor, discount_minor, tax_rate_bp, tax_minor, total_minor; product.published/updated v1 `variants[]`
  = {variant_id, sku, title}; order.cancelled v1 has order_id + cancelled_at. Every binding fct_order_line column exists.
- `data/clickhouse/models/` = REPLACEABLE objects (CREATE OR REPLACE VIEW), re-applied when the checksum changes
  (unlike migrations, which are refused on change); the runner gets a second mode. Tables behind MVs stay migrations.
- stg_<topic>_v<n>: views over `raw_events FINAL WHERE topic = … AND version = …` with JSONExtract typed columns.
- dim_variant: ARRAY JOIN variants of product.published/updated, argMax(product_id, sku by occurred_at) per
  (store_id, variant_id), last_seen_at. fct_order_line: ARRAY JOIN line_items + LEFT JOIN dim_variant;
  order_status = cancelled if an order.cancelled exists. Leave out email_hash/customer_id/title (no PII; title isn't
  needed).
- mv_orders_minute: the MV sees every INSERT, redeliveries included → AggregatingMergeTree with uniqState(event_id)
  for the order count; money via a FINAL-backed view on top (or argMax per event), never a plain sum in the MV.
- Marts: mart_bookings_daily, mart_cash_daily (store × currency × UTC day); mart_recognised_daily DROPPED.
- MANAGER DECISIONS 2026-10-25 (binding for #601):
  (1) Test month: the manager moves `posting/fixtures.ts` to `packages/test-utils`; code against
      `import { generateMonth, … } from '@platform/test-utils'` (same names and signatures). Wait for the sha on main.
  (2) Bookings test = a reference computed IN THE TEST from the same events with rpt_sales_daily's rules (exclude
      cancelled/voided/failed, awaiting counts, UTC day); Postgres = ClickHouse is #602's. Write the split in the PR body.
  (3a) Order counts use `uniqExactState`, never `uniq` (approximate). (3b) No money sums from an MV that sees
      redelivered inserts. MY PICK: `mv_orders_minute` writes per-order rows into a ReplacingMergeTree ORDER BY
      (store_id, currency, minute, event_id); the tile aggregates at read time with FINAL (state it in the PR). MVs and
      their TO tables go in MIGRATIONS; only plain views live in models/ (CREATE OR REPLACE, re-applied on a
      checksum change).
- (superseded) Open questions sent to the manager on 2026-10-25: (1) the #552 month (`generateMonth`) isn't in @platform/accounting's
  public API → REQUEST to window 15 for an export; (2) the "mart_bookings_daily = rpt_sales_daily row for row" test
  needs Postgres orders from the same month (the generator gives events only) → proposed: in #601, test against a
  reference computed from the events with rpt_sales_daily's rules, and leave the Postgres identity to #602.

## Next — Phase 5
- [ ] #600 live proof (machine) → counts into the PR body.
- [ ] #601 models: `data/clickhouse/models/` applied by the same runner (add the dir to `DEFAULT_SQL_DIRS`); the #552
      month is `generateMonth` in apps/accounting/src/posting/fixtures.ts, NOT in @platform/accounting's public API →
      REQUEST to window 15 to export it (or a `fixtures` subpath) before #601 tests can use it.
- [ ] Nits from the #502 review, for the next PR (not #502): a finance currency with no sales cannot be reached
      through the tabs (bi-report.tsx ~271, tabs come from sales only); no per-day refunds chart; `codeOf` falls back
      to `id.slice(0, 8)`.

## Decisions made (with reasons)
- #478 (manager 2026-10-18): views tested in `apps/core/src/modules/reporting/reporting-views.test.ts` on the
  migrated database (fails loudly if a view is missing). `net_minor` is cohort-attributed (succeeded refunds on the
  order's placement day); `rpt_refunds_daily` is the cash view by refund date. Sales exclude `cancelled`, `voided`
  AND `failed` payments; `awaiting` counts.
- Days are UTC calendar days in v1 (store time zones later).
- Views REVOKE ALL then GRANT SELECT to platform_app: 0009's default privileges would otherwise grant
  INSERT/UPDATE/DELETE on new relations.
- `fee_minor` = known fees only, plus `fee_unknown`; labelled unreconciled until Integration 4.
- #479 (manager 2026-10-18): `from`/`to` format date (UTC days, from inclusive, to exclusive, ≤ 366 days); currency
  per row + per-currency totals, no top-level currency; NO ledger in v1 (window 15, Phase 4); store operations use
  storeClientFor (one store) + an explicit store_id filter. Error code is `validation_error`.
- #480 (manager 2026-10-18): ownership widened to test/bi, test-contract/bi, e2e/bi (folders); a per-store stock tab,
  first page, no new sort (store.viewer includes `analyst from organization`); a LOCAL SVG chart inside bi/ (promoted
  only via a window 4 REQUEST); no store-view card in v1.
- #480: BI requires `analyst` (window 4's sections.ts), so a finance-only principal is refused by the guard; finance
  cards show for owner (finance + analyst). Series colours: dataviz dark categorical slots validated against the admin
  surface #131a22, fixed by store code.
- My CHANGELOG is `data/reporting/CHANGELOG.md`; the BI section's doc is `(hq)/bi/README.md`.
- STANDING RULE (manager 2026-10-18): after ANY edit to a contract yaml in packages/contracts run
  `pnpm --filter @platform/contracts generate` and commit the generated files.
- #600 (mine, 2026-10-25, reported to the manager for veto): the ingest runs its OWN kafkajs eachBatch loop, not the
  SDK's createConsumer — the SDK is per-message with a per-batch commit (no cross-partition size/time flush that
  commits after the ClickHouse ack) and it SKIPS unknown topics/versions, which #600 wants in the DLQ. Reuses the SDK's
  decodeMessage, DeadLetter shape, planTopics/ensureTopics for dlq.<group>, readDeadLetters, createValidator.
- #600: no processed store — ReplacingMergeTree(ingested_at) ORDER BY (topic, event_id) is the dedupe; readers count
  with FINAL. PARTITION BY toYYYYMM(occurred_at) is safe for folding (a copy has the same occurred_at).
- #600: the group id is resolved once in loadConfig; consumer, `dlqTopic` and the --once DLQ count all read it (#599).
- #600 (manager 2026-10-25): ClickHouse writer `platform` (ingest + migrator), reader `analytics_ro` (readonly=1: no
  per-query settings on the read path, hence `createChReader`); DDL tests on `analytics_test_<word>`, never drop
  `analytics` (the reader grant is bound to it); REQUEST #615 (window 14) adds analytics.raw to the DLQ policy.
- #600: the test month is generated from the event SCHEMAS (`src/testing/month.ts`, every topic@version, validated),
  so the ingest/PII tests need nothing from apps/accounting.

## Blocked / waiting
- #600 live proof: step 0 (ClickHouse rows in .env) + the machine.
- apps/core/CHANGELOG.md and apps/core/src/http/README.md call HQ finance `analyst` (it is `finance`): window 1's
  files, the manager routes it to window 1 — not mine.

## Gotchas learned
- ClickHouse ALIAS SHADOWING (bit three times in Phase 5): an output alias with a column's name (`toString(x) AS x`,
  `coalesce(sum(f),0) AS f`) replaces the column in WHERE / GROUP BY / other expressions of the same SELECT. Never
  alias a column to its own name; select raw columns (JSON renders UUID/DateTime64 as strings) or use out_* names.
- A destructive step (DELETE) must be guarded by a read-back of what the constructive step (re-insert) wrote.
- CI's `lint + typecheck` job runs `format:check` (prettier) over the WHOLE repo; a package's `eslint` does not.
  data/clickhouse/README.md failed it on #616/#618 (manager fixed it in 5069bd2 on the integration branch). Before
  every push: `pnpm exec prettier --check .` at the root. Expect a README conflict with 5069bd2 when merging main.
- 2026-10-25: a live test that runs whenever the services answer WILL run inside a plain `vitest run` once the shared
  stack has them (ClickHouse appeared on 18123 mid-session; one unasked ~30 s attempt, failed at auth, nothing
  written, reported). Live blocks are opt-in (`ANALYTICS_LIVE=1`, CI always) AND probe with the configured user.
- No python on this machine; Git-Bash `cat > file` without a heredoc waits on stdin forever (hung a command).
- ClickHouse `/ping` answers without credentials: probe with `SELECT 1` and the configured user.
- The local owner role `platform` is SUPERUSER + BYPASSRLS (checked in pg_roles), so it owns the views: a view
  WITHOUT security_invoker returns every store to a store client (mutation-tested: 11 of 21 tests fail with
  `security_invoker = false`). Never assume an owner-defined view is safe.
- node-postgres parses `date` as local midnight: compare days as text (`::date::text`) or format with local getters.
- The 4 live hq-rbac tests (roles.test.ts, scope.test.ts) answer 503 on this laptop (window 11 saw it too); green in
  CI — nothing to do.
- `refund` is window 7's table: read-only use only.
- A core module router reads `x-permission` from admin-api.yaml at construction and throws if the operation is
  missing, so a mount line can only land together with (or after) its yaml.
- Core route tests: `mountCoreMiddleware(app, verifier, { moduleRouters: moduleAdminRouters() })` exercises the
  production mount list.
- Seeded store-admin holds brands A AND B; a single-store admin needs its own staff_user + role_assignment.
- Admin server pages nest async components (guard → body): a test expands function components (awaiting async ones)
  before `render`; a page file may only export Next's page fields, so the body lives in `_components/`.
- Admin e2e against the core: a store-only principal on an HQ route is refused by the HQ LAYOUT guard ("This is an HQ
  section…"), not the section guard; scope chart locators to `figure` (the shell renders an img). Core mode:
  start `pnpm --filter @platform/core dev` detached, `E2E_API=core CORE_URL=http://localhost:9000 pnpm --filter
  @platform/admin e2e bi`, then stop only your own tsx-watch tree (check the command line before killing).
- The admin is dark-only (`--color-surface` #131a22): validate chart colours against that surface, not a light one.
- Bash heredocs/`node -e` strings eat backticks: write markdown with backticks through the Write/Edit tools.

## How to run & test this package
- Setup once per worktree: `pnpm install --frozen-lockfile`, `pnpm -r --filter "./packages/*" build`,
  `pnpm --filter @platform/auth-sdk fga:seed`.
- Ingest: `npx vitest run` from apps/analytics-ingest (~3 s, live block skipped); with the machine:
  `ANALYTICS_LIVE=1 npx vitest run src/live.test.ts`; `pnpm --filter @platform/analytics-ingest ch:migrate | once`.
- Core reporting: `DATABASE_URL=postgres://platform:platform@127.0.0.1:5433/platform DATABASE_URL_APP=postgres://platform_app:platform_app@127.0.0.1:5433/platform npx vitest run src/modules/reporting` from apps/core (~20 s).
- Admin BI: `npx vitest run test/bi` and `npx vitest run --config vitest.contract.config.ts test-contract/bi` from
  apps/admin.
- Gates: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/core --filter @platform/admin` (remove
  apps/core/.medusa first).

## Later phases (do not start until Memory-main says so)
### Phase 5 — Data platform & AI
ClickHouse ingest for live revenue by store; BigQuery via Airbyte + CDC; dbt models per store + consolidated with tests; Dagster; BI dashboards (finance = ledger); PostHog; AI: vector search, recs, Claude for copy/support/BI Q&A.
- [ ] ClickHouse ingest consumer
- [ ] Warehouse + Airbyte sources
- [ ] dbt models + tests
- [ ] Dagster
- [ ] Dashboards
- [ ] PostHog
- [ ] AI features
