// Admin API price-list routes (task 2.4, #137). Unlike the merchandising and media routers, these operations
// exist in contracts-v0.3 (`listPriceLists`, `createPriceList`, `upsertPrices`, tag `pricing`), so the
// x-permission and the request-body schema come straight from admin-api.yaml — the same `permission(op)` /
// `body(op)` arrangement as window 1's admin-routes.ts. Window 1 mounts `pricingRouter()` next to
// `adminRouter()` (REQUEST issue).
import { Router, type Request, type RequestHandler } from 'express';
import type { ScopedClient } from '@platform/db';
import { handle } from '../../http/errors';
import { loadSpec } from '../../http/openapi';
import { requirePermission, resolveObject } from '../../http/permissions';
import { one, uuidParam } from '../../http/query';
import { requirePrincipal, storeClientFor, type StaffPrincipal } from '../../http/staff-auth';
import { createPriceList, listPriceLists, upsertPrices, type PriceUpsertRow } from './pricing';

const spec = () => loadSpec('admin-api.yaml');

function permission(operationId: string): RequestHandler {
  const perm = spec().permission(operationId);
  return requirePermission(perm.relation, (req: Request) =>
    resolveObject(perm.object, { storeId: one(req.params.storeId) }),
  );
}

function body(operationId: string): RequestHandler {
  return (req, _res, next) => {
    try {
      spec().validateBody(operationId, req.body);
      next();
    } catch (err) {
      next(err);
    }
  };
}

function storeClient(req: Request): { p: StaffPrincipal; storeId: string; client: ScopedClient } {
  const p = requirePrincipal(req);
  const storeId = uuidParam(req.params, 'storeId');
  return { p, storeId, client: storeClientFor(p, storeId) };
}

export function pricingRouter(): Router {
  const r = Router();

  r.get(
    '/admin/stores/:storeId/price-lists',
    permission('listPriceLists'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      res.json({ items: await listPriceLists(client, storeId) });
    }),
  );
  r.post(
    '/admin/stores/:storeId/price-lists',
    permission('createPriceList'),
    body('createPriceList'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      res.status(201).json(await createPriceList(client, storeId, req.body, p.actor));
    }),
  );
  r.put(
    '/admin/stores/:storeId/price-lists/:priceListId/prices',
    permission('upsertPrices'),
    body('upsertPrices'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      const rows = (req.body as { prices: PriceUpsertRow[] }).prices;
      res.json(
        await upsertPrices(client, storeId, uuidParam(req.params, 'priceListId'), rows, p.actor),
      );
    }),
  );
  return r;
}
