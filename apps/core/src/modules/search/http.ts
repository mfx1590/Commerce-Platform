// Admin API merchandising routes (task 2.2, #135) as a mountable Express router. Permissions are each
// operation's `x-permission` from admin-api.yaml 0.4.0 (CONTRACT CHANGE #162: `store_staff` read /
// `store_admin` write), read through `loadSpec` like every other admin route; bodies are validated by
// merchandising-types.ts (same schemas as the spec). Window 1 mounts `merchandisingRouter(...)` next to
// `adminRouter()` (REQUEST in #162); nothing here is reachable until then.
import { Router, type Request } from 'express';
import type { ScopedClient } from '@platform/db';
import { AppError } from '../../lib/errors';
import { handle } from '../../http/errors';
import { loadSpec } from '../../http/openapi';
import { requirePermission, resolveObject } from '../../http/permissions';
import { uuidParam } from '../../http/query';
import { requirePrincipal, storeClientFor, type StaffPrincipal } from '../../http/staff-auth';
import {
  createRule,
  deleteRule,
  getRule,
  listRules,
  publishRules,
  updateRule,
} from './merchandising';
import type { MerchandisingRule } from './merchandising-types';
import type { RulesRepository } from './repository';
import type { IndexClient, StoreIndexTarget } from './types';

export interface MerchandisingRouterOptions {
  repository: RulesRepository;
  /** The index backend of a store, or null when the store has no search credentials (publish → 409). */
  indexFor: (store: StoreIndexTarget) => IndexClient | null;
}

export const MERCHANDISING_BASE = '/admin/stores/:storeId/merchandising';

function storeClient(req: Request): { p: StaffPrincipal; storeId: string; client: ScopedClient } {
  const p = requirePrincipal(req);
  const storeId = uuidParam(req.params, 'storeId');
  return { p, storeId, client: storeClientFor(p, storeId) };
}

/** `requirePermission` for the operation's `x-permission`; `{storeId}` in the object comes from the path. */
function permission(operationId: string) {
  const perm = loadSpec('admin-api.yaml').permission(operationId);
  return requirePermission(perm.relation, (req) =>
    resolveObject(perm.object, { storeId: uuidParam(req.params, 'storeId') }),
  );
}

/** Contract shape: `store_id` is internal. */
function toContract(rule: MerchandisingRule): Omit<MerchandisingRule, 'store_id'> {
  const { store_id: _storeId, ...rest } = rule;
  return rest;
}

async function loadStore(client: ScopedClient, storeId: string): Promise<StoreIndexTarget> {
  const r = await client.query<StoreIndexTarget>(
    'SELECT id, code, default_currency, search_index FROM store WHERE id = $1',
    [storeId],
  );
  const store = r.rows[0];
  if (!store) throw new AppError('not_found', `store ${storeId} not found`);
  return store;
}

export function merchandisingRouter(opts: MerchandisingRouterOptions): Router {
  const r = Router();
  const repo = opts.repository;

  r.get(
    `${MERCHANDISING_BASE}/rules`,
    permission('listMerchandisingRules'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      res.json({ items: (await listRules(client, storeId, repo)).map(toContract) });
    }),
  );
  r.post(
    `${MERCHANDISING_BASE}/rules`,
    permission('createMerchandisingRule'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      res.status(201).json(toContract(await createRule(client, storeId, req.body, repo)));
    }),
  );
  r.get(
    `${MERCHANDISING_BASE}/rules/:ruleId`,
    permission('getMerchandisingRule'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      res.json(toContract(await getRule(client, storeId, uuidParam(req.params, 'ruleId'), repo)));
    }),
  );
  r.patch(
    `${MERCHANDISING_BASE}/rules/:ruleId`,
    permission('updateMerchandisingRule'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      res.json(
        toContract(
          await updateRule(client, storeId, uuidParam(req.params, 'ruleId'), req.body, repo),
        ),
      );
    }),
  );
  r.delete(
    `${MERCHANDISING_BASE}/rules/:ruleId`,
    permission('deleteMerchandisingRule'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      await deleteRule(client, storeId, uuidParam(req.params, 'ruleId'), repo);
      res.status(204).end();
    }),
  );
  r.post(
    `${MERCHANDISING_BASE}/publish`,
    permission('publishMerchandisingRules'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      const store = await loadStore(client, storeId);
      const index = opts.indexFor(store);
      if (!index)
        throw new AppError('conflict', 'store has no search index configured', {
          store_code: store.code,
        });
      res.json(await publishRules(client, store, index, repo));
    }),
  );
  return r;
}
