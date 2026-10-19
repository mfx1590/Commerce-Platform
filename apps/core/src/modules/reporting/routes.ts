// The Admin API report operations (#479, window 12). Same chain as the other module routers: `permission(op)` (the
// operation's `x-permission`, read from admin-api.yaml — never hard-coded) → handler (scoped client → service →
// contract shape). The four operations are in admin-api.yaml (Admin API 0.4.19, CONTRACT CHANGE #493).
//
// Mounting: one line in `src/http/module-routers.ts` (window 1, REQUEST #494); the tests go through that same
// `moduleAdminRouters()` list behind the real middleware chain.
import { Router, type Request, type RequestHandler } from 'express';
import {
  handle,
  loadSpec,
  one,
  organizationClientFor,
  pageParams,
  requirePermission,
  requirePrincipal,
  resolveObject,
  storeClientFor,
  throwIfProblems,
  uuidParam,
} from '../../http';
import {
  hqFinanceReport,
  hqSalesReport,
  type ReportQuery,
  storeSalesReport,
  storeStockReport,
} from './service';

export const STORE_SALES_REPORT_PATH = '/admin/stores/:storeId/reports/sales';
export const STORE_STOCK_REPORT_PATH = '/admin/stores/:storeId/reports/stock';
export const HQ_SALES_REPORT_PATH = '/admin/hq/reports/sales';
export const HQ_FINANCE_REPORT_PATH = '/admin/hq/reports/finance';

type Operation =
  'getStoreSalesReport' | 'getStoreStockReport' | 'getHqSalesReport' | 'getHqFinanceReport';

/** `requirePermission` for an operation's `x-permission`; `{storeId}` in the object comes from the path. */
function permission(operationId: Operation): RequestHandler {
  const perm = loadSpec('admin-api.yaml').permission(operationId);
  return requirePermission(perm.relation, (req: Request) =>
    resolveObject(perm.object, { storeId: one(req.params.storeId) }),
  );
}

function window(req: Request): ReportQuery {
  const q: ReportQuery = {};
  const from = one(req.query.from);
  const to = one(req.query.to);
  const currency = one(req.query.currency);
  if (from !== undefined) q.from = from;
  if (to !== undefined) q.to = to;
  if (currency !== undefined) q.currency = currency;
  return q;
}

/** A client scoped to the ONE store in the path (403 outside the principal's scope). */
function oneStore(req: Request) {
  const p = requirePrincipal(req);
  const storeId = uuidParam(req.params, 'storeId');
  return { storeId, client: storeClientFor(p, storeId) };
}

export function reportingAdminRouter(): Router {
  const r = Router();

  r.get(
    STORE_SALES_REPORT_PATH,
    permission('getStoreSalesReport'),
    handle(async (req, res) => {
      const { client, storeId } = oneStore(req);
      res.json(await storeSalesReport(client, storeId, window(req)));
    }),
  );

  r.get(
    STORE_STOCK_REPORT_PATH,
    permission('getStoreStockReport'),
    handle(async (req, res) => {
      const { client, storeId } = oneStore(req);
      const problems: Record<string, string> = {};
      const paging = pageParams(req.query, 20, problems);
      throwIfProblems(problems);
      res.json(await storeStockReport(client, storeId, paging));
    }),
  );

  r.get(
    HQ_SALES_REPORT_PATH,
    permission('getHqSalesReport'),
    handle(async (req, res) => {
      res.json(await hqSalesReport(organizationClientFor(requirePrincipal(req)), window(req)));
    }),
  );

  r.get(
    HQ_FINANCE_REPORT_PATH,
    permission('getHqFinanceReport'),
    handle(async (req, res) => {
      res.json(await hqFinanceReport(organizationClientFor(requirePrincipal(req)), window(req)));
    }),
  );

  return r;
}
