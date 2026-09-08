// The Admin API routes of the marketing module (issue #145). Same chain as `src/http/admin-routes.ts`, which
// window 1 owns: `permission(op)` (the operation's `x-permission`, read from admin-api.yaml — never hard-coded)
// → `body(op)` (request body validated against the operation's requestBody schema) → handler (scoped client →
// service → contract shape).
//
// Mounting: `src/http` and `src/server.ts` belong to window 1, so this router is exported from the module's
// index.ts and mounted by ONE line there — requested in a REQUEST issue together with windows 7 and 8, the same
// route #162 took for the merchandising rules. Until that line lands, the router is mounted by this module's own
// route tests on a bare Express app, which is what proves the contract shapes; nothing else in the core imports
// it, so an unmounted router cannot break the running server (the hq-rbac lesson in Memory-main: a
// framework-neutral API is not done until something mounts it — hence the explicit REQUEST).
import { Router, type Request, type RequestHandler } from 'express';
import type { ScopedClient } from '@platform/db';
import {
  handle,
  loadSpec,
  one,
  pageParams,
  requirePermission,
  requirePrincipal,
  resolveObject,
  storeClientFor,
  throwIfProblems,
  uuidParam,
  type StaffPrincipal,
} from '../../http';
import {
  createCampaign,
  deleteCampaign,
  endCampaign,
  getCampaign,
  launchCampaign,
  listCampaigns,
  updateCampaign,
} from './campaigns';
import { attributionReport } from './reports';
import {
  CAMPAIGN_SORT_FIELDS,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TYPES,
  TOUCHES,
  type CampaignSortField,
  type CampaignStatus,
  type CampaignType,
  type SortOrder,
  type Touch,
} from './types';

const BASE = '/admin/stores/:storeId/marketing';
const spec = () => loadSpec('admin-api.yaml');

/** `requirePermission` for an operation's `x-permission`; `{storeId}` in the object comes from the path. */
function permission(operationId: string): RequestHandler {
  const perm = spec().permission(operationId);
  return requirePermission(perm.relation, (req: Request) =>
    resolveObject(perm.object, { storeId: one(req.params.storeId) }),
  );
}

/** Validates the JSON body against the operation's `requestBody` schema (400 `validation_error`). */
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

/** Store-scoped client for an admin request; `storeId` comes from the path (validated as a uuid). */
function storeClient(req: Request): { p: StaffPrincipal; storeId: string; client: ScopedClient } {
  const p = requirePrincipal(req);
  const storeId = uuidParam(req.params, 'storeId');
  return { p, storeId, client: storeClientFor(p, storeId) };
}

/**
 * A query parameter restricted to a contract enum. `src/http/query.ts` has the same helper but does not export
 * it through `src/http/index.ts`, and reaching past a folder's public API is exactly what the module rules
 * forbid — so it lives here until window 1 exports theirs (noted in the REQUEST).
 */
function enumParam<T extends string>(
  query: Request['query'],
  name: string,
  values: readonly T[],
  problems: Record<string, string>,
): T | undefined {
  const raw = one(query[name]);
  if (raw === undefined || raw === '') return undefined;
  if (!(values as readonly string[]).includes(raw)) {
    problems[name] = `one of ${values.join(', ')}`;
    return undefined;
  }
  return raw as T;
}

const ORDERS: readonly SortOrder[] = ['asc', 'desc'];

export function marketingAdminRouter(): Router {
  const r = Router();

  // ---- campaigns -------------------------------------------------------------------------------------------
  r.get(
    `${BASE}/campaigns`,
    permission('listCampaigns'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      const problems: Record<string, string> = {};
      const status = enumParam<CampaignStatus>(req.query, 'status', CAMPAIGN_STATUSES, problems);
      const type = enumParam<CampaignType>(req.query, 'type', CAMPAIGN_TYPES, problems);
      const sort = enumParam<CampaignSortField>(req.query, 'sort', CAMPAIGN_SORT_FIELDS, problems);
      const order = enumParam<SortOrder>(req.query, 'order', ORDERS, problems);
      const { page, limit } = pageParams(req.query, 20, problems);
      throwIfProblems(problems);
      res.json(
        await listCampaigns(client, storeId, {
          page,
          limit,
          ...(status ? { status } : {}),
          ...(type ? { type } : {}),
          ...(sort ? { sort } : {}),
          ...(sort && order ? { order } : {}),
        }),
      );
    }),
  );

  r.post(
    `${BASE}/campaigns`,
    permission('createCampaign'),
    body('createCampaign'),
    handle(async (req, res) => {
      const { client, storeId, p } = storeClient(req);
      res.status(201).json(await createCampaign(client, storeId, req.body, p.actor));
    }),
  );

  r.get(
    `${BASE}/campaigns/:campaignId`,
    permission('getCampaign'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      res.json(await getCampaign(client, storeId, uuidParam(req.params, 'campaignId')));
    }),
  );

  r.patch(
    `${BASE}/campaigns/:campaignId`,
    permission('updateCampaign'),
    body('updateCampaign'),
    handle(async (req, res) => {
      const { client, storeId, p } = storeClient(req);
      res.json(
        await updateCampaign(
          client,
          storeId,
          uuidParam(req.params, 'campaignId'),
          req.body,
          p.actor,
        ),
      );
    }),
  );

  r.delete(
    `${BASE}/campaigns/:campaignId`,
    permission('deleteCampaign'),
    handle(async (req, res) => {
      const { client, storeId, p } = storeClient(req);
      await deleteCampaign(client, storeId, uuidParam(req.params, 'campaignId'), p.actor);
      res.status(204).end();
    }),
  );

  r.post(
    `${BASE}/campaigns/:campaignId/launch`,
    permission('launchCampaign'),
    handle(async (req, res) => {
      const { client, storeId, p } = storeClient(req);
      res.json(await launchCampaign(client, storeId, uuidParam(req.params, 'campaignId'), p.actor));
    }),
  );

  r.post(
    `${BASE}/campaigns/:campaignId/end`,
    permission('endCampaign'),
    handle(async (req, res) => {
      const { client, storeId, p } = storeClient(req);
      res.json(await endCampaign(client, storeId, uuidParam(req.params, 'campaignId'), p.actor));
    }),
  );

  // ---- reports ---------------------------------------------------------------------------------------------
  // `viewer` on the store (the spec's "any relation" convention), so an HQ analyst reads it next to store staff.
  r.get(
    `${BASE}/reports/attribution`,
    permission('getAttributionReport'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      const problems: Record<string, string> = {};
      const touch = enumParam<Touch>(req.query, 'touch', TOUCHES, problems);
      throwIfProblems(problems);
      res.json(
        await attributionReport(client, storeId, {
          from: one(req.query.from) ?? '',
          to: one(req.query.to) ?? '',
          ...(touch ? { touch } : {}),
        }),
      );
    }),
  );

  return r;
}
