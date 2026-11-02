// BI Q&A's two operations (#606, contract #668), both `viewer` on `store:*` like queryMetrics:
//   POST /admin/metrics/ask                              askMetrics          → ask.ts
//   POST /admin/metrics/ask/{conversationId}/feedback    askMetricsFeedback  → feedback.ts (the asker only, else 404)
// Fail closed: an operation the contract does not carry is a 503 before anything runs (operationGuard). The AI gateway
// is packages/ai's (`ai.ts`: purpose `analysis`, the Redis limiter, `ai_call_audit`); tests inject one over its
// scripted fake transport. Feedback is stored in `ai_qa_feedback` (0206) through the caller's own tenant client.
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
import { defaultGatewayFor } from './ai';
import { askMetrics } from './ask';
import { createPgFeedbackStore, type FeedbackStore, type Rating } from './feedback';
import type { GatewayFactory } from './gateway';

export const ASK_PATH = '/admin/metrics/ask';
export const ASK_FEEDBACK_PATH = '/admin/metrics/ask/:conversationId/feedback';

export interface AskRouterOptions {
  reader?: MetricsReader;
  spec?: MetricsSpec;
  /** the AI gateway per question; default: packages/ai's (ai.ts) */
  gatewayFor?: GatewayFactory;
  /** where a caller's ratings go; default: `ai_qa_feedback` through their tenant client (tests: a memory store) */
  feedbackFor?: (p: StaffPrincipal) => FeedbackStore;
}

type StaffPrincipal = ReturnType<typeof requirePrincipal>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `settings.ai.bi_qa` of these stores, read through the caller's own tenant client. Only a JSON `false` switches a store
 * off: absent, `true`, or any value that is not a JSON boolean (a string "no", a number, `ai` not an object) counts as
 * ON — the owner's default (2026-11-01) — and never fails the question (a `::boolean` cast of a string would).
 */
async function biQaSwitches(
  p: StaffPrincipal,
  ids: readonly string[],
): Promise<ReadonlyMap<string, boolean>> {
  if (ids.length === 0) return new Map();
  const client = hasOrganizationAccess(p) ? organizationClientFor(p) : visibleStoresClientFor(p);
  const r = await client.query<{ id: string; bi_qa: boolean | null }>(
    `SELECT id,
            CASE WHEN jsonb_typeof(settings -> 'ai' -> 'bi_qa') = 'boolean'
                 THEN (settings -> 'ai' -> 'bi_qa')::boolean END AS bi_qa
       FROM store WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(r.rows.filter((x) => x.bi_qa !== null).map((x) => [x.id, x.bi_qa!]));
}

/** `ai_qa_feedback` under the caller's own scope (store_nullable RLS: an HQ conversation only for HQ principals). */
const defaultFeedback = (p: StaffPrincipal): FeedbackStore =>
  createPgFeedbackStore(
    hasOrganizationAccess(p) ? organizationClientFor(p) : visibleStoresClientFor(p),
  );

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
      const stores = await metricsScope(p);
      try {
        const answer = await askMetrics(
          {
            reader: opts.reader ?? sharedMetricsReader(),
            gatewayFor: opts.gatewayFor ?? defaultGatewayFor,
            biQaSwitches: (ids) => biQaSwitches(p, ids),
          },
          {
            organizationId: p.organizationId,
            actorId: p.user.id,
            stores,
            finance: await can(p, 'finance', 'organization:hq'),
            organizationScope: hasOrganizationAccess(p),
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
      const feedback = (opts.feedbackFor ?? defaultFeedback)(p);
      const key = {
        organizationId: p.organizationId,
        conversationId: conversationId.toLowerCase(),
        actorId: p.user.id,
      };
      // not the asker's (or no such conversation): 404, so ids are never confirmed
      if (!(await feedback.owns(key)))
        throw new AppError('not_found', 'no such conversation', { conversationId });
      await feedback.record({ ...key, rating: rating satisfies Rating });
      res.status(204).end();
    }),
  );

  return r;
}
