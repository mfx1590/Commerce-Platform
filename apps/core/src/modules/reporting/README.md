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

| File                      | What                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                | Public API: `reportingAdminRouter`, the four service functions, `parseReportWindow`, `REPORTING_VIEWS`, types.                                                                                                                                                                                                                                                                                 |
| `service.ts`              | One function per report: `ScopedClient` in, contract shape out.                                                                                                                                                                                                                                                                                                                                |
| `routes.ts`               | `reportingAdminRouter()`: `requirePermission` with the spec's `x-permission` → scoped client → service.                                                                                                                                                                                                                                                                                        |
| `testing/fixtures.ts`     | Seeded throwaway database migrated through 0200 (fails loudly if a view is missing) + the money fixtures both test files use.                                                                                                                                                                                                                                                                  |
| `reporting-views.test.ts` | #478: each view equals a direct aggregate as brand A and as HQ; visibility through `security_invoker`; no SECURITY DEFINER dependency, SELECT-only grant; bigint money beside currency; net reconciliation; PII denylist.                                                                                                                                                                      |
| `reports.test.ts`         | #479: window rules; each report equals the views; per-currency totals; the permission matrix (store admin of A, analyst, finance, owner); 400 / 403 / 404 / 401; through the production router list (`moduleAdminRouters()`); the spec carries the four operations with the planned permissions; responses and the spec examples validated against admin-api.yaml; no PII key in any response. |

Rules: every read goes through the scoped client from `src/http` (`storeClientFor` / `organizationClientFor`); no
PII in any response; money stays per currency.

Test: `pnpm --filter @platform/core test -- src/modules/reporting`.
