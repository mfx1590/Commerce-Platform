# Changelog — data/reporting

## Unreleased — Phase 3 (window 12)

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
