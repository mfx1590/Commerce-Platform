# Changelog — data/reporting

## Unreleased — Phase 3 (window 12)

### 2026-10-18 · Reporting views, proposed migration 0200 (#478)

- `proposed/0200_reporting_views.sql`: `rpt_sales_daily`, `rpt_payments_daily`, `rpt_refunds_daily`,
  `rpt_stock_position`, `rpt_customers_daily`, all `security_invoker`, SELECT only for `platform_app`; partial
  indexes on `payment (store_id, captured_at)` and `refund (store_id, created_at)`.
- Sales exclude cancelled orders and voided or failed payments; `net_minor` is cohort-attributed (refunds on the
  order's placement day); `rpt_refunds_daily` is the cash view.
- Reconciliation tests in `apps/core/src/modules/reporting/reporting-views.test.ts`.
