// The Admin API surface of the pick/pack lifecycle (CONTRACT CHANGE #225), as a mountable router. Mount point
// (REQUEST #176, window 1): `routers.push(fulfillmentAdminRouter())` in `src/http/module-routers.ts`, after
// `adminRouter()` — the same staff principal, JSON body parser and error handler as every other admin route.
//
// Permissions are read from a spec, never hard-coded: the real `admin-api.yaml` first, and only while #225 is
// still open, `proposed/admin-api.pick-pack.yaml` — the same three operations, filed verbatim. When Admin API
// 0.4.3 lands, the fallback and the proposed file are deleted and nothing else changes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router, type RequestHandler } from 'express';
import { parse } from 'yaml';
import { handle } from '../../http/errors';
import { loadSpec } from '../../http/openapi';
import { requirePermission, resolveObject, type PermissionRelation } from '../../http/permissions';
import { enumParam, one, pageParams, throwIfProblems, uuidParam } from '../../http/query';
import {
  organizationClientFor,
  requirePrincipal,
  storeClientFor,
  type StaffPrincipal,
} from '../../http/staff-auth';
import { AppError } from '../../lib/errors';
import { listPickLists, packShipment, pickShipment, PICK_LIST_STATUSES } from './lifecycle';

export const PICK_SHIPMENT_PATH = '/admin/shipments/:shipmentId/pick';
export const PACK_SHIPMENT_PATH = '/admin/shipments/:shipmentId/pack';
export const PICK_LISTS_PATH = '/admin/stores/:storeId/pick-lists';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProposedSpec {
  paths?: Record<
    string,
    Record<string, { operationId?: string; 'x-permission'?: { relation: string; object: string } }>
  >;
}

let proposed: ProposedSpec | undefined;

/** The operation's `x-permission`: the real spec when it has the operation, else #225's filed copy. */
function permissionFor(operationId: string): { relation: PermissionRelation; object: string } {
  try {
    return loadSpec('admin-api.yaml').permission(operationId);
  } catch {
    proposed ??= parse(
      readFileSync(join(__dirname, 'proposed', 'admin-api.pick-pack.yaml'), 'utf8'),
    ) as ProposedSpec;
    for (const operations of Object.values(proposed.paths ?? {})) {
      for (const operation of Object.values(operations)) {
        if (operation.operationId === operationId && operation['x-permission']) {
          return {
            relation: operation['x-permission'].relation as PermissionRelation,
            object: operation['x-permission'].object,
          };
        }
      }
    }
    throw new AppError('internal', `no x-permission for operation ${operationId}`);
  }
}

function permission(operationId: string): RequestHandler {
  const perm = permissionFor(operationId);
  return requirePermission(perm.relation, (req) =>
    resolveObject(perm.object, {
      storeId: typeof req.params.storeId === 'string' ? req.params.storeId : undefined,
    }),
  );
}

/** The store a shipment belongs to, for the two operations whose path names none. Unknown → 404. */
async function storeOfShipment(p: StaffPrincipal, shipmentId: string): Promise<string> {
  const r = await organizationClientFor(p).query<{ store_id: string }>(
    `SELECT store_id FROM shipment WHERE id = $1`,
    [shipmentId],
  );
  const storeId = r.rows[0]?.store_id;
  if (!storeId) throw new AppError('not_found', `shipment ${shipmentId} not found`);
  return storeId;
}

export function fulfillmentAdminRouter(): Router {
  const r = Router();

  r.post(
    PICK_SHIPMENT_PATH,
    permission('pickShipment'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const shipmentId = uuidParam(req.params, 'shipmentId');
      const client = storeClientFor(p, await storeOfShipment(p, shipmentId));
      res.json(await pickShipment(client, shipmentId, p.actor));
    }),
  );

  r.post(
    PACK_SHIPMENT_PATH,
    permission('packShipment'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const shipmentId = uuidParam(req.params, 'shipmentId');
      const client = storeClientFor(p, await storeOfShipment(p, shipmentId));
      const parcelCount = (req.body as { parcel_count?: unknown } | undefined)?.parcel_count;
      res.json(
        await packShipment(client, shipmentId, {
          actor: p.actor,
          ...(parcelCount === undefined ? {} : { parcelCount: Number(parcelCount) }),
        }),
      );
    }),
  );

  r.get(
    PICK_LISTS_PATH,
    permission('listPickLists'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const storeId = uuidParam(req.params, 'storeId');
      const problems: Record<string, string> = {};
      const { page, limit } = pageParams(req.query, 20, problems);
      const status = enumParam(req.query, 'status', PICK_LIST_STATUSES, problems);
      const warehouseId = one(req.query.warehouse_id);
      if (warehouseId !== undefined && !UUID.test(warehouseId)) problems.warehouse_id = 'uuid';
      throwIfProblems(problems);
      res.json(
        await listPickLists(storeClientFor(p, storeId), storeId, {
          ...(warehouseId ? { warehouseId } : {}),
          ...(status ? { status } : {}),
          page,
          limit,
        }),
      );
    }),
  );

  return r;
}
