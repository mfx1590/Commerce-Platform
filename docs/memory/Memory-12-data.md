# Memory 12 — Data platform, BI & AI
Window: 12 · Key: `data` · Branch prefix: `data/` · Branch: `data/phase3`
Last updated: 2026-10-18 · Contracts: contracts-v0.4.22 (Admin API 0.4.19), db 0.3.8 · Status: Phase 3 reporting v1 — 12.1 and 12.2 merged; 12.3 (#480) built, PR waits for the ownership row on main

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
Manager: "Manager session seven" (local_484d7727-b945-48ba-bb27-0366bd2bbdcc) since 2026-10-18; six
(local_08108b05-…) retired. Plan before building, report PR up (number + head sha), report checks done.

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

## In progress
- #480: PR #502 (Closes #480), reviewed: BLOCK only on this record, fixed by this memory commit; the manager queues it
  once checks are green. Push NOTHING else and do not merge main again (the queue does that). `apps/admin/e2e/bi/bi.spec.ts` ran ONCE on the kept core with the manager's go (2026-10-18): 2 passed
  (store-admin 403; owner sees brands A, B, C, finance card, EUR tab). First invocation failed on two spec locators
  (the HQ layout guard answers a store-only user before the BI guard; the shell has its own img), fixed and re-run.
  Core stopped afterwards, "machine free" reported.

## Next — Phase 3
- [ ] After #480: ask the manager for the next docket (reporting v1 is then complete).
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

## Blocked / waiting
- PR for #480: the manager's review and merge.
- apps/core/CHANGELOG.md and apps/core/src/http/README.md call HQ finance `analyst` (it is `finance`): window 1's
  files, the manager routes it to window 1 — not mine.

## Gotchas learned
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
