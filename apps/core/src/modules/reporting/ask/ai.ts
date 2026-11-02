// The production AI gateway for BI Q&A (#606, packages/ai #669): purpose `analysis`, one gateway per question, scoped
// by askMetrics (a store question → that store's budget and audit; an organization-level principal's → the
// organization's, `storeId: null`). As catalog/copy-draft.ts does: one Redis limiter per process, created on first
// use; the transport is resolved only when a call goes out, so `AI_ENABLED` off is `ai_disabled` (the gateway refuses
// before the transport) even without a key configured; every model step is one `ai_call_audit` row (no content).
import {
  createAiGateway,
  createAnthropicTransport,
  createPgAuditSink,
  createRedisLimiter,
  type AiTransport,
  type UsageLimiter,
} from '@platform/ai';
import { getPool } from '../../../lib/db';
import type { GatewayFactory } from './gateway';

let redisLimiter: UsageLimiter | null = null;
const lazyTransport: AiTransport = {
  kind: 'anthropic',
  complete: (req) => createAnthropicTransport().complete(req),
} as AiTransport;

export const defaultGatewayFor: GatewayFactory = (scope) =>
  createAiGateway({
    organizationId: scope.organizationId,
    storeId: scope.storeId,
    purpose: 'analysis',
    actorId: scope.actorId,
    transport: lazyTransport,
    limiter: (redisLimiter ??= createRedisLimiter()),
    audit: createPgAuditSink(getPool()),
  });
