// The Admin API routes of the marketing module (issue #145). Same chain as `src/http/admin-routes.ts`, which
// window 1 owns: `permission(op)` (the operation's `x-permission`, read from admin-api.yaml — never hard-coded)
// → `body(op)` (request body validated against the operation's requestBody schema) → handler (scoped client →
// service → contract shape).
//
// Mounting: `src/http` and `src/server.ts` belong to window 1, so this router is exported from the module's
// index.ts and mounted by one line in `src/http/module-routers.ts` (REQUEST #181, merged). The route tests still
// mount it themselves on a bare Express app behind the real middleware chain, which is what proves the contract
// shapes without depending on window 1's file.
import { Router, type Request, type RequestHandler } from 'express';
import type { ScopedClient } from '@platform/db';
import {
  enumParam,
  handle,
  loadSpec,
  one,
  organizationClientFor,
  pageParams,
  requirePermission,
  requirePrincipal,
  resolveObject,
  sortParams,
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
import {
  createFeed,
  deleteFeed,
  getFeed,
  listFeedItems,
  listFeeds,
  publishFeed,
  updateFeed,
} from './feeds';
import { FEED_CHANNELS, FEED_STATUSES, type FeedChannel, type FeedStatus } from './feed-types';
import { attributionReport } from './reports';
import {
  createSegment,
  createSegmentTemplate,
  deleteSegment,
  deleteSegmentTemplate,
  getSegment,
  getSegmentTemplate,
  listSegments,
  listSegmentTemplates,
  materializeSegment,
  previewSegment,
  updateSegment,
  updateSegmentTemplate,
} from './segments';
import { SEGMENT_SORT_FIELDS, type SegmentSortField } from './segment-types';
import {
  CAMPAIGN_SORT_FIELDS,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TYPES,
  TOUCHES,
  type CampaignSortField,
  type CampaignStatus,
  type CampaignType,
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
      const sorting = sortParams<CampaignSortField>(req.query, CAMPAIGN_SORT_FIELDS, problems);
      const { page, limit } = pageParams(req.query, 20, problems);
      throwIfProblems(problems);
      res.json(
        await listCampaigns(client, storeId, {
          page,
          limit,
          ...(status ? { status } : {}),
          ...(type ? { type } : {}),
          ...sorting,
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

  // ---- segments --------------------------------------------------------------------------------------------
  r.get(
    `${BASE}/segments`,
    permission('listSegments'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      const problems: Record<string, string> = {};
      const sorting = sortParams<SegmentSortField>(req.query, SEGMENT_SORT_FIELDS, problems);
      const { page, limit } = pageParams(req.query, 20, problems);
      throwIfProblems(problems);
      res.json(await listSegments(client, storeId, { page, limit, ...sorting }));
    }),
  );

  r.post(
    `${BASE}/segments`,
    permission('createSegment'),
    body('createSegment'),
    handle(async (req, res) => {
      const { client, storeId, p } = storeClient(req);
      res.status(201).json(await createSegment(client, storeId, req.body, p.actor));
    }),
  );

  r.get(
    `${BASE}/segments/:segmentId`,
    permission('getSegment'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      res.json(await getSegment(client, storeId, uuidParam(req.params, 'segmentId')));
    }),
  );

  r.patch(
    `${BASE}/segments/:segmentId`,
    permission('updateSegment'),
    body('updateSegment'),
    handle(async (req, res) => {
      const { client, storeId, p } = storeClient(req);
      res.json(
        await updateSegment(client, storeId, uuidParam(req.params, 'segmentId'), req.body, p.actor),
      );
    }),
  );

  r.delete(
    `${BASE}/segments/:segmentId`,
    permission('deleteSegment'),
    handle(async (req, res) => {
      const { client, storeId, p } = storeClient(req);
      await deleteSegment(client, storeId, uuidParam(req.params, 'segmentId'), p.actor);
      res.status(204).end();
    }),
  );

  // Writes nothing; `store_staff` may run it, because previewing a count is reading.
  r.post(
    `${BASE}/segments/:segmentId/preview`,
    permission('previewSegment'),
    body('previewSegment'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      const override = (req.body as { rules?: unknown } | undefined)?.rules;
      res.json(await previewSegment(client, storeId, uuidParam(req.params, 'segmentId'), override));
    }),
  );

  // 202 per the contract: the refresh is a job as far as the caller is concerned, even though it currently
  // completes inline — so moving it onto a worker later is not a contract change.
  r.post(
    `${BASE}/segments/:segmentId/materialize`,
    permission('materializeSegment'),
    handle(async (req, res) => {
      const { client, storeId, p } = storeClient(req);
      res
        .status(202)
        .json(
          await materializeSegment(client, storeId, uuidParam(req.params, 'segmentId'), p.actor),
        );
    }),
  );

  // ---- organization segment templates ------------------------------------------------------------------
  // Organization scope, not store scope: `store_id IS NULL` rows are invisible to a tenant client (RLS
  // `store_nullable`), so these handlers use an organization client. Reads are `viewer`, writes are `owner`.
  r.get(
    '/admin/marketing/segment-templates',
    permission('listSegmentTemplates'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const problems: Record<string, string> = {};
      const { page, limit } = pageParams(req.query, 20, problems);
      throwIfProblems(problems);
      res.json(await listSegmentTemplates(organizationClientFor(p), { page, limit }));
    }),
  );

  r.post(
    '/admin/marketing/segment-templates',
    permission('createSegmentTemplate'),
    body('createSegmentTemplate'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      res
        .status(201)
        .json(await createSegmentTemplate(organizationClientFor(p), req.body, p.actor));
    }),
  );

  r.get(
    '/admin/marketing/segment-templates/:templateId',
    permission('getSegmentTemplate'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      res.json(
        await getSegmentTemplate(organizationClientFor(p), uuidParam(req.params, 'templateId')),
      );
    }),
  );

  r.patch(
    '/admin/marketing/segment-templates/:templateId',
    permission('updateSegmentTemplate'),
    body('updateSegmentTemplate'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      res.json(
        await updateSegmentTemplate(
          organizationClientFor(p),
          uuidParam(req.params, 'templateId'),
          req.body,
          p.actor,
        ),
      );
    }),
  );

  r.delete(
    '/admin/marketing/segment-templates/:templateId',
    permission('deleteSegmentTemplate'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      await deleteSegmentTemplate(
        organizationClientFor(p),
        uuidParam(req.params, 'templateId'),
        p.actor,
      );
      res.status(204).end();
    }),
  );

  // ---- feeds -----------------------------------------------------------------------------------------------
  r.get(
    `${BASE}/feeds`,
    permission('listFeeds'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      const problems: Record<string, string> = {};
      const channel = enumParam<FeedChannel>(req.query, 'channel', FEED_CHANNELS, problems);
      const status = enumParam<FeedStatus>(req.query, 'status', FEED_STATUSES, problems);
      const { page, limit } = pageParams(req.query, 20, problems);
      throwIfProblems(problems);
      res.json(
        await listFeeds(client, storeId, {
          page,
          limit,
          ...(channel ? { channel } : {}),
          ...(status ? { status } : {}),
        }),
      );
    }),
  );

  r.post(
    `${BASE}/feeds`,
    permission('createFeed'),
    body('createFeed'),
    handle(async (req, res) => {
      const { client, storeId, p } = storeClient(req);
      res.status(201).json(await createFeed(client, storeId, req.body, p.actor));
    }),
  );

  r.get(
    `${BASE}/feeds/:feedId`,
    permission('getFeed'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      res.json(await getFeed(client, storeId, uuidParam(req.params, 'feedId')));
    }),
  );

  r.patch(
    `${BASE}/feeds/:feedId`,
    permission('updateFeed'),
    body('updateFeed'),
    handle(async (req, res) => {
      const { client, storeId, p } = storeClient(req);
      res.json(
        await updateFeed(client, storeId, uuidParam(req.params, 'feedId'), req.body, p.actor),
      );
    }),
  );

  r.delete(
    `${BASE}/feeds/:feedId`,
    permission('deleteFeed'),
    handle(async (req, res) => {
      const { client, storeId, p } = storeClient(req);
      await deleteFeed(client, storeId, uuidParam(req.params, 'feedId'), p.actor);
      res.status(204).end();
    }),
  );

  r.post(
    `${BASE}/feeds/:feedId/publish`,
    permission('publishFeed'),
    handle(async (req, res) => {
      const { client, storeId, p } = storeClient(req);
      res.json(await publishFeed(client, storeId, uuidParam(req.params, 'feedId'), p.actor));
    }),
  );

  r.get(
    `${BASE}/feeds/:feedId/items`,
    permission('listFeedItems'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      const problems: Record<string, string> = {};
      const { page, limit } = pageParams(req.query, 20, problems);
      throwIfProblems(problems);
      res.json(
        await listFeedItems(client, storeId, uuidParam(req.params, 'feedId'), { page, limit }),
      );
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
