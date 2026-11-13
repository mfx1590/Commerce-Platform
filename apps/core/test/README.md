# apps/core/test

Cross-module tests of the core's HTTP app: they mount the real middleware chain (`mountCoreMiddleware`) and read
other modules only through their public `index.ts` (ADR 0005, lint-enforced here too). Each DB test creates and
drops its own database. Module-level tests live next to their module under `src/`.

## Contract coverage (`contract-coverage.test.ts`, #858)

Every operation of `admin-api.yaml` and `store-api.yaml` must have a route the core mounts, or sit in the file's
`ALLOWLIST` as `operationId: <issue>` (the issue that serves it, or removes it from the contract). The routes are read
from the app, not grepped: `mountCoreMiddleware()` composes a bare Express app as `createServer()` does (the module
Admin, Store and webhook routers included) and the test walks Express's router stack, nested routers too; hq-rbac's
routes come from its own table (`HQ_RBAC_ROUTES`, plus `FINANCE_PING_ROUTE` outside production — the rule
`createHqRbac` applies). No database: it runs in the required `unit` job.

- **Fails both ways.** An unserved operation that is not allowlisted fails with a table (spec, operationId,
  method + path); an allowlisted operation that is served now (or left the contract) fails too — delete it from
  `ALLOWLIST` in the PR that serves it. Mutation-checked both ways (#858 PR).
- **Not in the contract.** A route under `/admin` or `/store` the contract does not have fails unless
  `NOT_IN_CONTRACT` names it with a reason; today only hq-rbac's test double `GET /admin/finance/ping`, which the
  production table does not contain (asserted).
- **Initial allowlist (2026-11-13, 12 of 172 operations):** `updateOrderLineItem`, `cancelOrderLineItem` (#855),
  `getMarketingDashboard` (#856), and #857's eight Admin referral/review operations plus Store `listProductReviews`.

## The access matrix (`access-matrix.test.ts`, Integration 5 gate 3, #612)

Every BI, metrics, AI and recommendation route × the principals that matter (owner, finance, HQ analyst, HQ
support, a store admin of brand A only, a store admin of brand B only, an active staff user with NO role, no token;
for the Store API route: the publishable key of A, of B, none) → the status the contract's `x-permission` and ADR
0002 decide. The table in the file is the documentation: each row names the rule that decides it, and the run
prints one summary line per route (`[access-matrix] <operationId> <METHOD> <path> — owner 200, …`).

- **The guard itself.** The no-role staff user is 403 on every admin route, and the 403 must come from
  `requirePermission` (its message names the operation's `x-permission`, read from the contract): listMetrics and
  askMetrics also refuse a caller with no store in their own handler, so the status alone would survive a removed
  guard. Removing the listMetrics or queryMetrics guard locally fails the test.
- **Completeness.** The routes come from the contract (admin-api.yaml operations tagged `reports`, window 17's three
  marketing reports, every operation that documents an `ai_*` error; store-api.yaml's recommendations) and from the
  mounted routers' stacks (`reportingAdminRouter()` with metrics and ask nested, the marketing `/reports/` routes,
  `moduleStoreRouters()`). A route in either list without a row fails the test; so does a stale row.
- **The leak.** Data in brand A and brand B (orders with a promotion code and an attributed touch, abandoned carts,
  popular recommendations, the seed's catalogue and stock); a store-A principal calls every row-returning route and
  no id of any brand-B row (every public table with a `store_id`) or brand-B marker may appear. Naming brand B is a
  403 before any read; a brand-B product through a brand-A path is a 404. A store admin of both stores must name one
  on askMetrics (400 `store_required`, the AI budget is per store); queryMetrics has no such rule (the contract runs
  it over every store the caller views).
- **Unit job only.** Principals are dev tokens decided by the `role_assignment` stub that mirrors ADR 0002;
  OpenFGA's parity is `auth-live.test.ts`. ClickHouse is an unreachable port and `AI_ENABLED=0`, so `queryMetrics`
  and `askMetrics` stop after the guard (503) and `askMetricsFeedback` answers 404 for a conversation the caller
  never had: those cells prove the guard. Their rows are covered by window 12: the leak property on real ClickHouse
  in `src/modules/reporting/metrics/metrics-live.test.ts`, and the scope of every compiled statement in
  `metrics/routes.test.ts` and `ask/routes.test.ts` (fake reader, scripted model). `draftProductCopy` runs on a fake
  model through the catalog's `setCopyDraftGatewayFactory` seam.
- **HQ support** (`support` on the organization) is a viewer of every store by ADR 0002 (lines 33 and 35), so it
  reads every store's viewer-gated reports, metrics and ask. That is the reviewed policy (#612), not a finding.
