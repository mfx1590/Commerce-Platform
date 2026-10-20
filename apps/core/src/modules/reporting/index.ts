// reporting public API (window 12, reporting v1).
//   * 12.1 (#478): the reporting views are packages/db migration 0200 (db 0.3.8); this module names them.
//   * 12.2 (#479): the four Admin API report operations — `reportingAdminRouter()` (mounted by one line in
//     `src/http/module-routers.ts`) and the service functions behind it.
export const REPORTING_VIEWS = [
  'rpt_sales_daily',
  'rpt_payments_daily',
  'rpt_refunds_daily',
  'rpt_stock_position',
  'rpt_customers_daily',
] as const;

export type ReportingView = (typeof REPORTING_VIEWS)[number];

export {
  HQ_FINANCE_REPORT_PATH,
  HQ_SALES_REPORT_PATH,
  reportingAdminRouter,
  STORE_SALES_REPORT_PATH,
  STORE_STOCK_REPORT_PATH,
} from './routes';
export {
  hqFinanceReport,
  hqSalesReport,
  parseReportWindow,
  REFUND_REASONS,
  storeSalesReport,
  storeStockReport,
} from './service';
export type {
  FinanceCurrencyTotal,
  FinanceReport,
  FinanceRow,
  RefundReason,
  ReportQuery,
  ReportWindow,
  SalesCurrencyTotal,
  SalesReport,
  SalesRow,
  SalesTotal,
  StockPosition,
  StockReport,
} from './service';
