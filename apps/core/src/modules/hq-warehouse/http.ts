// Admin API routes of hq-warehouse (#436): cycle counts. One Express router, mounted by one line in
// `src/http/module-routers.ts` after `adminRouter()` — the same staff principal, JSON body parser and error
// handler as every other admin route.
//
// Permissions are each operation's `x-permission` from `admin-api.yaml`, read through `loadSpec` like every other
// admin route. The three operations are CONTRACT CHANGE #458 and reach the spec with this module's PR; until the
// spec carries them, the permission and the body rules are the proposed ones below (the fallback disappears with
// the proposed copies).
import { Router, type RequestHandler } from 'express';
import { handle } from '../../http/errors';
import { loadSpec } from '../../http/openapi';
import { requirePermission, resolveObject } from '../../http/permissions';
import { enumParam, one, pageParams, throwIfProblems, uuidParam } from '../../http/query';
import { organizationClientFor, requirePrincipal } from '../../http/staff-auth';
import { validationError } from '../../lib/errors';
import {
  createCycleCount,
  CYCLE_COUNT_STATUSES,
  listCycleCounts,
  reconcileCycleCount,
} from './cycle-counts';

export const CYCLE_COUNTS_PATH = '/admin/cycle-counts';
export const RECONCILE_CYCLE_COUNT_PATH = '/admin/cycle-counts/:cycleCountId/reconcile';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROPOSED_PERMISSION = { relation: 'operations', object: 'organization:hq' } as const;

type Operation = 'createCycleCount' | 'listCycleCounts' | 'reconcileCycleCount';

function specHas(operationId: Operation): boolean {
  try {
    loadSpec('admin-api.yaml').permission(operationId);
    return true;
  } catch {
    return false;
  }
}

function permission(operationId: Operation): RequestHandler {
  const perm = specHas(operationId)
    ? loadSpec('admin-api.yaml').permission(operationId)
    : PROPOSED_PERMISSION;
  return requirePermission(perm.relation, () => resolveObject(perm.object, {}));
}

/** The spec validates the body once it knows the operation; the checks below hold either way. */
function validated(operationId: Operation, body: unknown): Record<string, unknown> {
  if (specHas(operationId)) loadSpec('admin-api.yaml').validateBody(operationId, body);
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw validationError('request body must be a JSON object', { body: 'object' });
  }
  return body as Record<string, unknown>;
}

function createInput(body: Record<string, unknown>) {
  const problems: Record<string, string> = {};
  const uuid = (name: string): string => {
    const v = body[name];
    if (typeof v !== 'string' || !UUID.test(v)) problems[name] = 'uuid';
    return String(v);
  };
  const warehouseId = uuid('warehouse_id');
  const stockItemId = uuid('stock_item_id');
  const countedQuantity = body.counted_quantity;
  if (
    typeof countedQuantity !== 'number' ||
    !Number.isSafeInteger(countedQuantity) ||
    countedQuantity < 0
  ) {
    problems.counted_quantity = 'integer >= 0';
  }
  let countedAt: Date | undefined;
  if (body.counted_at !== undefined) {
    countedAt = typeof body.counted_at === 'string' ? new Date(body.counted_at) : new Date(NaN);
    if (Number.isNaN(countedAt.getTime())) problems.counted_at = 'date-time';
  }
  if (body.note !== undefined && typeof body.note !== 'string') problems.note = 'string';
  for (const key of Object.keys(body)) {
    if (
      !['warehouse_id', 'stock_item_id', 'counted_quantity', 'counted_at', 'note'].includes(key)
    ) {
      problems[key] = 'unknown property';
    }
  }
  throwIfProblems(problems);
  return {
    warehouseId,
    stockItemId,
    countedQuantity: countedQuantity as number,
    ...(countedAt ? { countedAt } : {}),
    ...(typeof body.note === 'string' ? { note: body.note } : {}),
  };
}

export function cycleCountsAdminRouter(): Router {
  const r = Router();

  r.get(
    CYCLE_COUNTS_PATH,
    permission('listCycleCounts'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const problems: Record<string, string> = {};
      const { page, limit } = pageParams(req.query, 20, problems);
      const status = enumParam(req.query, 'status', CYCLE_COUNT_STATUSES, problems);
      const warehouseId = one(req.query.warehouse_id);
      if (warehouseId !== undefined && !UUID.test(warehouseId)) problems.warehouse_id = 'uuid';
      const stockItemId = one(req.query.stock_item_id);
      if (stockItemId !== undefined && !UUID.test(stockItemId)) problems.stock_item_id = 'uuid';
      throwIfProblems(problems);
      res.json(
        await listCycleCounts(organizationClientFor(p), {
          ...(warehouseId ? { warehouseId } : {}),
          ...(stockItemId ? { stockItemId } : {}),
          ...(status ? { status } : {}),
          page,
          limit,
        }),
      );
    }),
  );

  r.post(
    CYCLE_COUNTS_PATH,
    permission('createCycleCount'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const input = createInput(validated('createCycleCount', req.body));
      const count = await createCycleCount(
        organizationClientFor(p),
        { organizationId: p.organizationId, ...input },
        p.actor,
      );
      res.status(201).json(count);
    }),
  );

  r.post(
    RECONCILE_CYCLE_COUNT_PATH,
    permission('reconcileCycleCount'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const cycleCountId = uuidParam(req.params, 'cycleCountId');
      const body = validated('reconcileCycleCount', req.body);
      if (body.approve !== undefined && typeof body.approve !== 'boolean') {
        throw validationError('approve must be a boolean', { approve: 'boolean' });
      }
      res.json(
        await reconcileCycleCount(
          organizationClientFor(p),
          cycleCountId,
          { organizationId: p.organizationId, approve: body.approve === true },
          p.actor,
        ),
      );
    }),
  );

  return r;
}
