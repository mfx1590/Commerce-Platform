# Memory 12 — Data platform, BI & AI
Window: 12 · Key: `data` · Branch prefix: `data/` · Branch: `data/phase3`
Last updated: 2026-10-18 · Contracts: contracts-v0.4.19, db 0.3.8 · Status: Phase 3 reporting v1 — 12.1 (#478) in review

## Identity (does not change)
Owned paths (write), per docs/ownership.md row `data/`:
- `data/**`
- `apps/analytics-ingest/**`
- `apps/core/src/modules/reporting/**`
- `apps/admin/src/app/(hq)/bi/**`
Route mounting = REQUEST to window 1 (`src/http/module-routers.ts`); admin rail = window 4. Migrations, contracts,
events, docs (except this file) = main window via `CONTRACT CHANGE:`. Manager: "Manager session six"
(local_08108b05-8a7d-4006-ad3a-d58dc83b0723) — plan before building, report PR up (number + head sha), report checks done.

## Mission — Phase 3 (reporting v1, manager decision 2026-10-16: option C)
security_invoker views read through the tenant-scoped client → Admin API report operations under existing OpenFGA
checks → admin `(hq)/bi` section. NO Metabase in v1 (12.4 sandbox deferred until the owner asks).
- 12.1 #478 views + reconciliation tests · 12.2 #479 Admin API report operations · 12.3 #480 BI section.

## Done
- 12.1 #478: PR 486 (head 81ca1c3: views proposed + tests) → CONTRACT CHANGE #485 ACCEPTED; the manager landed
  0200 verbatim as packages/db migration (db 0.3.8, commit 941eaaa) on integration/reporting-views (71f76f6).
  Cleanup commit on data/phase3-reporting (cut from 71f76f6): tests run on the landed migration, proposed/ deleted.
  PR 486 is not merged on its own: GitHub marks it merged with the integration PR.

## In progress
- #478: waiting for the manager to merge the integration PR (integration/reporting-views + my cleanup commit).
  Push NOTHING more to data/phase3 until it is merged.

## Next — Phase 3
- [ ] 12.2 #479: `data/reporting/proposed/admin-api.reports.yaml` (4 operations), CONTRACT CHANGE + REQUEST to
      window 1 for mounting; reporting router in `apps/core/src/modules/reporting/` against the views; plan to
      manager first.
- [ ] 12.3 #480: admin `(hq)/bi` section.

## Decisions made (with reasons)
- 2026-10-18 (manager, on the #478 plan): Q1 tests live in `apps/core/src/modules/reporting/reporting-views.test.ts`
  (data/ is not a workspace package; root config is main's) (after landing: on the migrated database, failing loudly if a view
  is missing). Q2 `net_minor` is cohort-attributed (succeeded refunds on the order's placement day);
  `rpt_refunds_daily` is the cash view by refund date. Q3 sales exclude `cancelled`, `voided` AND `failed`
  payments; `awaiting` counts (invoice/manual orders are sales until paid or cancelled).
- Days are UTC calendar days in v1 (store time zones later).
- Views REVOKE ALL then GRANT SELECT to platform_app: 0009's default privileges would otherwise grant
  INSERT/UPDATE/DELETE on new relations.
- `fee_minor` = known fees only, plus `fee_unknown` count; labelled unreconciled until Integration 4.
- My CHANGELOG is `data/reporting/CHANGELOG.md` (apps/core/CHANGELOG.md is window 1's).

## Blocked / waiting
- Integration PR for #478/#485 (manager). After it merges: merge main into data/phase3, then start 12.2 with a plan.

## Gotchas learned
- The local owner role `platform` is SUPERUSER + BYPASSRLS (checked in pg_roles), so it owns the views: a view WITHOUT security_invoker returns
  every store to a store client (mutation-tested: 11 of 21 tests fail with `security_invoker = false`). Never
  assume an owner-defined view is safe.
- node-postgres parses `date` as local midnight: compare days as text (`::date::text`) or format with local getters.
- The 4 live hq-rbac tests (roles.test.ts, scope.test.ts) answer 503 on this laptop (window 11 saw it too);
  green in CI — manager says nothing to do.
- `refund` is window 7's table: read-only use only.

## How to run & test this package
- Setup once per worktree: `pnpm install --frozen-lockfile`, `pnpm -r --filter "./packages/*" build`,
  `pnpm --filter @platform/auth-sdk fga:seed`.
- Views test: `DATABASE_URL=postgres://platform:platform@127.0.0.1:5433/platform DATABASE_URL_APP=postgres://platform_app:platform_app@127.0.0.1:5433/platform npx vitest run src/modules/reporting/reporting-views.test.ts` from apps/core (~10 s).
- Gates: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/core` (remove apps/core/.medusa first).

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
