# reporting (window 12)

Reporting v1 in the core: the Admin API report operations (#479) over the 0200 reporting views (#478). Views,
grain, filters and the security model: `data/reporting/README.md`.

## Operations

| operationId           | Path                                        | x-permission                   | Client                                   |
| --------------------- | ------------------------------------------- | ------------------------------ | ---------------------------------------- |
| `getStoreSalesReport` | `GET /admin/stores/{storeId}/reports/sales` | `viewer` on `store:{storeId}`  | `storeClientFor(p, storeId)` (one store) |
| `getStoreStockReport` | `GET /admin/stores/{storeId}/reports/stock` | `viewer` on `store:{storeId}`  | `storeClientFor(p, storeId)` (one store) |
| `getHqSalesReport`    | `GET /admin/hq/reports/sales`               | `analyst` on `organization:hq` | `organizationClientFor(p)`               |
| `getHqFinanceReport`  | `GET /admin/hq/reports/finance`             | `finance` on `organization:hq` | `organizationClientFor(p)`               |

- `from` / `to`: UTC days (`YYYY-MM-DD`), `from` inclusive, `to` exclusive, at most 366 days; optional `currency`.
  Anything else is 400 `validation_error`. An unknown store is 404 `not_found`; a store outside the principal's
  scope is 403 `forbidden` (the same chain as the other `/admin/stores/{storeId}/…` routes).
- Every amount is an integer `*_minor` beside a `currency` on the same row; totals are per store and currency
  (`totals`) and per currency (`currency_totals`) — never summed across currencies.
- The store operations are fenced twice (manager decision Q4): a client scoped to that one store, and an explicit
  `store_id` filter (for stock, which has no store column: an `EXISTS` on the store's variants).
- Finance is a cash view: payments by capture day, succeeded refunds by refund day, `refunded_by_reason`.
  `fees_reconciled` is always `false` until Integration 4. No ledger figures in v1 (`ledger_entry` is window 15's
  Phase 4 table).
- Stock: the current position (no window), paged (`page`, `limit` ≤ 100, default 20), ordered by `sku`, then
  `warehouse_code`.

The operations are in `packages/contracts/openapi/admin-api.yaml` (Admin API 0.4.19, CONTRACT CHANGE #493);
`permission()` reads each `x-permission` from the spec. Window 1 mounts the router in `src/http/module-routers.ts`
(`moduleAdminRouters()`, REQUEST #494).

## Files

| File                      | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                | Public API: `reportingAdminRouter`, the four service functions, `parseReportWindow`, `REPORTING_VIEWS`, types.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `service.ts`              | One function per report: `ScopedClient` in, contract shape out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `routes.ts`               | `reportingAdminRouter()`: `requirePermission` with the spec's `x-permission` → scoped client → service.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `testing/fixtures.ts`     | Seeded throwaway database migrated through 0200 (fails loudly if a view is missing) + the money fixtures both test files use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `reporting-views.test.ts` | #478: each view equals a direct aggregate as brand A and as HQ; visibility through `security_invoker`; no SECURITY DEFINER dependency, SELECT-only grant; bigint money beside currency; net reconciliation; PII denylist.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `reports.test.ts`         | #479: window rules; each report equals the views; per-currency totals; the permission matrix (store admin of A, analyst, finance, owner); 400 / 403 / 404 / 401; through the production router list (`moduleAdminRouters()`); the spec carries the four operations with the planned permissions; responses and the spec examples validated against admin-api.yaml; no PII key in any response.                                                                                                                                                                                                                                     |
| `reconcile-gate.test.ts`  | #602, the Integration 5 money gate: the generated month (projected rows + `withEvents` outbox) through ONE real relay run into the real ledger consumer and the ClickHouse ingest, then `reconcile` (@platform/analytics-ingest) over HTTP against this module's routes mounted in-process (dev tokens) and the Finance API (verifier seam): every identity at 0, and a forged ledger copy and a changed order are caught. Live job only (`ANALYTICS_LIVE=1` / `CI=true` + ClickHouse and broker probes); skipped with a printed reason otherwise. The devDependencies it needs are an integration exception (manager 2026-10-27). |

Rules: every read goes through the scoped client from `src/http` (`storeClientFor` / `organizationClientFor`); no
PII in any response; money stays per currency.

Test: `pnpm --filter @platform/core test -- src/modules/reporting`.

## Metrics API (#603, D4) — `metrics/`

`listMetrics` (`GET /admin/metrics`) and `queryMetrics` (`POST /admin/metrics/query`), both `viewer` on `store:*`,
mounted inside `reportingAdminRouter()`. One query path over ClickHouse for the admin BI and, later, the BI Q&A tool
(#606). There is no SQL input anywhere.

- **Scope comes from the server.** An HQ principal (any organization relation; all five imply store `viewer` in
  `infra/openfga/model.fga`) gets every store of the organization. Anyone else gets the stores they view (the OpenFGA
  scope for real tokens, `role_assignment` for dev tokens). Every compiled statement carries
  `store_id IN {scope:Array(UUID)}`. A `filters.store_ids` entry outside the scope is a **403** naming the store,
  never empty rows. A finance metric without `finance` on `organization:hq` is a 403. In both cases nothing reaches
  ClickHouse.
- **The vocabulary is closed** (`catalogue.ts`): 13 metrics, 4 dimensions, 4 grains, the limits.
  - `query.ts` validates; a 400 names the field, a dimension a metric does not accept, or customer counts mixed with
    money. An empty filter list (`store_ids`, `currencies`, `product_ids`, `refund_reasons`: `[]`) is a 400 too —
    omit the filter instead (#638 review A; it used to reach the compiler's empty-scope guard as a 500).
  - `compile.ts` emits one statement per model, every value a server parameter, output columns `out_*` / `m_*`
    (never a column's own name, the ClickHouse alias-shadow trap).
  - `execute.ts` merges by key. Ratios are integer half-up and null when the divisor is 0. Totals are per currency,
    never across currencies. It applies `order_by` / `limit` (1000, `truncated`) and sets `data_as_of`.
- **The read path** (`reader.ts`) is `analytics_ro` with no per-query settings. The profile sets readonly,
  10 s, 100 000 rows with throw and 512 MB (data/clickhouse/access/20_analytics_ro.sql). A timeout, an overflow, a missing
  configuration or ClickHouse being down is a **503 `unavailable`** (contracts 0.4.30) with nothing partial. The
  executor starts every statement before awaiting any, so a failing ClickHouse never leaves an unhandled rejection.
- **Fail closed.** The `x-permission` is resolved per request from admin-api.yaml (Admin API 0.4.25), so an
  operation the spec does not carry answers 503 `unavailable` before anything runs (tested).

Tests:

- `metrics/metrics.test.ts` (30): the validator, a 500-random-query property (scope in every statement, no request
  value in SQL text), and the executor.
- `metrics/routes.test.ts` (12): real core middleware, dev tokens, a recording reader, the landed contract's
  permissions. Covers 401, the scope per role, 403 for B from A, 403 for every finance metric without finance (an
  analyst and a store admin; nothing reaches ClickHouse), 400, 503 `unavailable`, CSV, and fail closed.
- `metrics/metrics-live.test.ts` (10, ClickHouse + Postgres, opt-in like the other live tests). Every metric at every
  grain. A 300-query leak property (no row of another store, totals = the marts). Two-store exactness. p95 of 200
  queries < 300 ms (measured 52–56 ms). The `analytics_ro` read path. The scope-escape tests over HTTP: (a) another
  store → 403, (b) no filter → exactly its own totals, (c) a store dimension → only its own store, (d) finance → 403,
  and an organization principal sees all three brands.

## BI Q&A (#606, D9) — `ask/`

A question in words, answered with AI tool use over the metrics API. **No SQL is generated or accepted anywhere.**
`POST /admin/metrics/ask` and `POST /admin/metrics/ask/{conversationId}/feedback` (CONTRACT CHANGE #668), both
`viewer` on `store:*` (Admin API 0.4.27). `askMetrics` runs on packages/ai's gateway (`ask/ai.ts`: purpose `analysis`,
the Redis limiter, `ai_call_audit`, the Anthropic transport resolved only when a call goes out, so `AI_ENABLED` off is
`ai_disabled` even without a key); feedback is live on `ai_qa_feedback` (packages/db 0206).

- **Before the model sees anything** (`ask.ts`):
  - a `store_ids` entry outside the caller's scope → 403;
  - stores with `store.settings.ai.bi_qa = false` are left out and listed in `excluded_store_ids`, and only stores the caller may see are ever listed. Only a JSON `false` switches a store off: absent, `true`, or anything that is not a JSON boolean counts as ON (the owner default, 2026-11-01) and never fails the question. If none are left → 403 `bi_qa_off`.
  - The budget and audit scope follow the **principal**, never the store count (#677 review): an organization-level principal is charged and audited to the organization (`storeId: null`), even when they name one store. Anyone else asks about exactly ONE store — a store principal with several stores must name it in `store_ids` (400 `validation_error`, `details.reason: store_required`, before anything is sent); the store view always sends its own.
- **One tool, `query_metrics`** (`tool.ts`): a `MetricQuery` schema narrowed to the caller's metrics and stores.
  - Every call goes through the SAME `parseMetricQuery` → `scopeForQuery` (`metrics/scope.ts`, shared with `queryMetrics`) → `executeMetricQuery`.
  - A call outside the scope, or not a valid query, becomes a tool error: the analytics store is never read, and the model sees the refusal.
  - Each result carries a `ref` (`q1`, `q2` …) that the answer cites. At most 200 rows go back to the model, each naming its store by CODE (`store: "brand-a"`) — packages/ai redacts what is sent, and its phone pattern currently eats digit runs inside a uuid (reported to window 14); the real ids are in the tool schema's enum (not redacted) and in the caller's full, capped result.
- **The answer** (`MetricAnswer`): the text, every query that parsed (its result or its error), a chart hint (the first day-grain query), `excluded_store_ids`, the model and the template.
- **Gateway errors** map to the contract (`gateway.ts`): `ai_disabled` 503, `ai_budget_exceeded` / `ai_rate_limited` 429 (+ `Retry-After`), `ai_refused` / `ai_tool_limit` 422, `ai_unavailable` 502, `unavailable` 503.
- **Feedback** (`feedback.ts`): up or down from the asker only (a 404 for anyone else, so ids are not confirmed). No free text; append-only, and the newest rating counts. Stored in `ai_qa_feedback` through the CALLER's tenant client, so `store_nullable` RLS scopes it: an organization conversation (store NULL) is invisible to a store principal.
- **The gateway** is `GatewayLike` (`runTools` as #669 landed it); production is `createAiGateway` (`ask/ai.ts`). `gateway.test.ts` and the golden set run askMetrics on the REAL gateway over packages/ai's scripted fake transport (what is sent, the audit per step, store vs organization scope, the kill switch, the loop cap, redaction). `testing/fake-gateway.ts` plays recorded tool calls with #669's rules (the loop cap, unknown tools, gateway errors). The unit and route tests use it; the gateway tests and the golden set use the real one.

Tests:

- `ask/ask.test.ts` (22): the five store-B cases (body 403 before the model; the tool refused with the analytics store untouched; scope [A] only; no finance for an analyst; injected SQL has no path), the per-store switch, the budget scope, the error map, the window and the chart hint.
- `ask/routes.test.ts` (8): over HTTP with dev tokens and a seeded database: 401, store B, the organization budget for an analyst, a store switched off, Retry-After, feedback by the asker only, fail closed.
- `ask/golden/` (32): the **golden set of 30 questions** with recorded tool calls (`cases.ts`), each held to its results by `run.ts`: refused calls refused, every figure in the answer backed by the result it cites, citations resolve, no other store's row. A test proves the checks are not vacuous. Unit on a fake reader; **live** on the generated month in ClickHouse (opt-in like the other live tests). A real-model run replays the same questions once the owner's key exists.
