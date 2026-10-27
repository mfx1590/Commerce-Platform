# Changelog — data/reporting

## Unreleased — Phase 5 (window 12)

### 2026-10-27 · the Integration 5 money gate (#602)

- `apps/core/src/modules/reporting/reconcile-gate.test.ts`: the reporting routes are the core side of the bookings and
  cash identities (`getHqSalesReport`, `getHqFinanceReport`), read over HTTP by `reconcile` on the generated month.

## Unreleased — Phase 3 (window 12)

### 2026-10-18 · BI section in the admin (#480)

- `apps/admin/src/app/(hq)/bi`: the placeholder replaced by the HQ BI page — currency tabs (never a sum), KPI cards,
  net revenue and orders per day per store (a local SVG chart), a per-store table; finance cards only for finance
  principals (fees labelled unreconciled); a per-store stock tab (first page). Wrappers in `_api.ts` over window 4's
  `adminCall`; helpers in `_lib/report.ts`; doc in `(hq)/bi/README.md`.
- Tests: `apps/admin/test/bi` (helpers; the page per principal with the real section guard) and
  `apps/admin/test-contract/bi` (the wrappers against Prism).
- Core: a test that an HQ analyst reads a store's stock; `REFUND_REASONS.includes` in the finance report.

### 2026-10-18 · Report operations landed (Admin API 0.4.19, CONTRACT CHANGE #493; mount REQUEST #494)

- The four operations live in `packages/contracts/openapi/admin-api.yaml`; `proposed/admin-api.reports.yaml` is deleted.
- `reports.test.ts` runs on the real spec and through the production router list (`moduleAdminRouters()`): no
  fragment merge, no `CONTRACTS_OPENAPI_DIR` copy; it checks the four operations and their permissions in the spec.

### 2026-10-18 · Admin API report operations (#479)

- `proposed/admin-api.reports.yaml`: `getStoreSalesReport`, `getStoreStockReport`, `getHqSalesReport`,
  `getHqFinanceReport` with `SalesReport`, `StockReport`, `FinanceReport` (+ `SalesFigures`, `StockPosition`,
  `FinanceFigures`) and the `ReportFrom` / `ReportTo` / `ReportCurrency` parameters (CONTRACT CHANGE, Admin API 0.4.18).
- Core reporting module: `service.ts`, `routes.ts` (`reportingAdminRouter()`), `testing/fixtures.ts` shared by both
  test files; `reports.test.ts` (19 cases). Mounting is a REQUEST to window 1.

### 2026-10-18 · Migration 0200 landed (db 0.3.8, CONTRACT CHANGE #485)

- The views live in `packages/db/migrations/0200_reporting_views.sql`; `proposed/` is deleted.
- `reporting-views.test.ts` runs on the landed migration (createTestDatabase + seed) and fails loudly if one of the
  five views is missing; it no longer reads a proposed file.

### 2026-10-18 · Reporting views, proposed migration 0200 (#478)

- `proposed/0200_reporting_views.sql`: `rpt_sales_daily`, `rpt_payments_daily`, `rpt_refunds_daily`,
  `rpt_stock_position`, `rpt_customers_daily`, all `security_invoker`, SELECT only for `platform_app`; partial
  indexes on `payment (store_id, captured_at)` and `refund (store_id, created_at)`.
- Sales exclude cancelled orders and voided or failed payments; `net_minor` is cohort-attributed (refunds on the
  order's placement day); `rpt_refunds_daily` is the cash view.
- Reconciliation tests in `apps/core/src/modules/reporting/reporting-views.test.ts`.
