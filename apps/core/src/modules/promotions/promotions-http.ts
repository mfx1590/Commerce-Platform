// Admin API promotion routes (task 2.5, #138). Every permission is the operation's `x-permission` from
// admin-api.yaml 0.4.1 (`getPromotion` / `updatePromotion` landed with CONTRACT CHANGE #189); bodies are
// validated by promotions-types.ts (same shapes as the spec plus the cross-field rules). Not mounted yet:
// window 1 adds it to src/http/module-routers.ts (REQUEST #179, amended 2026-09-14).
import { Router, type Request, type RequestHandler } from 'express';
import type { ScopedClient } from '@platform/db';
import { handle } from '../../http/errors';
import { loadSpec } from '../../http/openapi';
import { requirePermission, resolveObject } from '../../http/permissions';
import { enumParam, one, pageParams, throwIfProblems, uuidParam } from '../../http/query';
import { requirePrincipal, storeClientFor, type StaffPrincipal } from '../../http/staff-auth';
import { createPromotion, getPromotion, listPromotions, updatePromotion } from './promotions';

const spec = () => loadSpec('admin-api.yaml');

function specPermission(operationId: string): RequestHandler {
  const perm = spec().permission(operationId);
  return requirePermission(perm.relation, (req: Request) =>
    resolveObject(perm.object, { storeId: one(req.params.storeId) }),
  );
}

function storeClient(req: Request): { p: StaffPrincipal; storeId: string; client: ScopedClient } {
  const p = requirePrincipal(req);
  const storeId = uuidParam(req.params, 'storeId');
  return { p, storeId, client: storeClientFor(p, storeId) };
}

const SORTS = ['name', 'code', 'status', 'starts_at', 'created_at'] as const;
const STATUSES = ['active', 'draft', 'disabled'] as const;

export function promotionsRouter(): Router {
  const r = Router();

  r.get(
    '/admin/stores/:storeId/promotions',
    specPermission('listPromotions'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      const problems: Record<string, string> = {};
      const page = pageParams(req.query, 20, problems);
      const sort = enumParam(req.query, 'sort', SORTS, problems);
      const order = enumParam(req.query, 'order', ['asc', 'desc'] as const, problems);
      const status = enumParam(req.query, 'status', STATUSES, problems);
      throwIfProblems(problems);
      res.json(
        await listPromotions(client, storeId, {
          ...page,
          ...(sort ? { sort } : {}),
          ...(order ? { order } : {}),
          ...(status ? { status } : {}),
        }),
      );
    }),
  );
  r.post(
    '/admin/stores/:storeId/promotions',
    specPermission('createPromotion'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      res.status(201).json(await createPromotion(client, storeId, req.body, p.actor));
    }),
  );
  r.get(
    '/admin/stores/:storeId/promotions/:promotionId',
    specPermission('getPromotion'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      res.json(await getPromotion(client, storeId, uuidParam(req.params, 'promotionId')));
    }),
  );
  r.patch(
    '/admin/stores/:storeId/promotions/:promotionId',
    specPermission('updatePromotion'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      res.json(
        await updatePromotion(
          client,
          storeId,
          uuidParam(req.params, 'promotionId'),
          req.body,
          p.actor,
        ),
      );
    }),
  );
  return r;
}
