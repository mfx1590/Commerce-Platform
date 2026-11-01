// BI Q&A's two operations (#606, contract #668), both `viewer` on `store:*` like queryMetrics:
//   POST /admin/metrics/ask                              askMetrics          → ask.ts
//   POST /admin/metrics/ask/{conversationId}/feedback    askMetricsFeedback  → feedback.ts (the asker only, else 404)
// Fail closed twice: an operation the contract does not carry yet is a 503 before anything runs (operationGuard), and
// until REQUEST #669 (the gateway's tool loop) and the `ai_qa_feedback` table land, production answers 503 too —
// tests inject the scripted gateway and a memory feedback store.
import { Router } from 'express';
import {
  can,
  handle,
  hasOrganizationAccess,
  loadSpec,
  organizationClientFor,
  requirePrincipal,
  visibleStoresClientFor,
} from '../../../http';
import { AppError } from '../../../lib/errors';
import type { MetricsReader } from '../metrics/execute';
import { sharedMetricsReader } from '../metrics/reader';
import { metricsScope, operationGuard, type MetricsSpec } from '../metrics/routes';
import { askMetrics } from './ask';
import type { FeedbackStore, Rating } from './feedback';
import type { GatewayFactory } from './gateway';

export const ASK_PATH = '/admin/metrics/ask';
export const ASK_FEEDBACK_PATH = '/admin/metrics/ask/:conversationId/feedback';

export interface AskRouterOptions {
  reader?: MetricsReader;
  spec?: MetricsSpec;
  /** the AI gateway per call; production has none until #669 lands (503) */
  gatewayFor?: GatewayFactory;
  /** where ratings go; production has none until `ai_qa_feedback` lands (503) */
  feedback?: FeedbackStore;
}

type StaffPrincipal = ReturnType<typeof requirePrincipal>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `settings.ai.bi_qa` of these stores, read through the caller's own tenant client; absent = ON. */
async function biQaSwitches(
  p: StaffPrincipal,
  ids: readonly string[],
): Promise<ReadonlyMap<string, boolean>> {
  if (ids.length === 0) return new Map();
  const client = hasOrganizationAccess(p) ? organizationClientFor(p) : visibleStoresClientFor(p);
  const r = await client.query<{ id: string; bi_qa: boolean | null }>(
    `SELECT id, (settings -> 'ai' -> 'bi_qa')::boolean AS bi_qa FROM store WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(r.rows.filter((x) => x.bi_qa !== null).map((x) => [x.id, x.bi_qa!]));
}

const notYet = (what: string, issue: string) =>
  new AppError('unavailable', `BI Q&A ${what} is not available yet (${issue})`);

export function askAdminRouter(opts: AskRouterOptions = {}): Router {
  const spec: MetricsSpec = opts.spec ?? loadSpec('admin-api.yaml');
  const guard = operationGuard(spec);
  const r = Router();

  r.post(
    ASK_PATH,
    guard('askMetrics'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      spec.validateBody('askMetrics', req.body);
      if (!opts.gatewayFor) throw notYet("the AI gateway's tool use", '#669');
      const stores = await metricsScope(p);
      try {
        const answer = await askMetrics(
          {
            reader: opts.reader ?? sharedMetricsReader(),
            gatewayFor: opts.gatewayFor,
            biQaSwitches: (ids) => biQaSwitches(p, ids),
          },
          {
            organizationId: p.organizationId,
            actorId: p.user.id,
            stores,
            finance: await can(p, 'finance', 'organization:hq'),
          },
          req.body as { question: string; store_ids?: string[]; from?: string; to?: string },
        );
        res.json(answer);
      } catch (err) {
        // the contract's Retry-After on a rate limit (#664's rule, the same 60 s window)
        if (err instanceof AppError && err.code === 'ai_rate_limited') res.set('Retry-After', '60');
        throw err;
      }
    }),
  );

  r.post(
    ASK_FEEDBACK_PATH,
    guard('askMetricsFeedback'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const conversationId = String(req.params.conversationId);
      if (!UUID.test(conversationId))
        throw new AppError('validation_error', 'conversationId must be a uuid', {
          field: 'conversationId',
        });
      spec.validateBody('askMetricsFeedback', req.body);
      // the closed vocabulary again, server-side (the spec validator is the first line, not the only one)
      const rating = (req.body as { rating?: unknown } | undefined)?.rating;
      if (rating !== 'up' && rating !== 'down')
        throw new AppError('validation_error', 'rating must be up or down', { field: 'rating' });
      if (!opts.feedback) throw notYet('feedback', 'the ai_qa_feedback table, #606');
      const key = {
        organizationId: p.organizationId,
        conversationId: conversationId.toLowerCase(),
        actorId: p.user.id,
      };
      // not the asker's (or no such conversation): 404, so ids are never confirmed
      if (!(await opts.feedback.owns(key)))
        throw new AppError('not_found', 'no such conversation', { conversationId });
      await opts.feedback.record({ ...key, rating: rating satisfies Rating });
      res.status(204).end();
    }),
  );

  return r;
}
