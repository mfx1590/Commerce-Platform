// reporting public API (window 12, reporting v1).
//   * 12.1 (#478): the reporting views are a proposed migration (data/reporting/proposed/0200); this module names
//     them. The report operations of 12.2 (#479) read them through the tenant-scoped client.
export const REPORTING_VIEWS = [
  'rpt_sales_daily',
  'rpt_payments_daily',
  'rpt_refunds_daily',
  'rpt_stock_position',
  'rpt_customers_daily',
] as const;

export type ReportingView = (typeof REPORTING_VIEWS)[number];
