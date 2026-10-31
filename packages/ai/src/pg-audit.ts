// The Postgres audit sink: one ai_call_audit row per gateway call (0205, #605), written through the tenant client in
// store scope, so RLS checks that the row belongs to the store the session acts for. Append-only: the app role has
// INSERT and SELECT only. Never content: the record type has no field that could carry any.
import { createTenantClient } from '@platform/db';
import type { Pool } from 'pg';
import type { AuditRecord, AuditSink } from './audit.js';

const INSERT = `INSERT INTO ai_call_audit (
    organization_id, store_id, actor_id, purpose, template_id, template_version, input_sha256, redactions,
    model, served_model, input_tokens, output_tokens, cache_read_tokens, cost_estimate_micro_usd, latency_ms,
    outcome, error_class
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
  RETURNING id`;

/** `pool` is the application-role pool (DATABASE_URL_APP), subject to RLS. */
export function createPgAuditSink(pool: Pool): AuditSink {
  return {
    async write(r: AuditRecord): Promise<string> {
      const db = createTenantClient(pool, {
        organizationId: r.organizationId,
        storeIds: [r.storeId],
        actorId: r.actorId,
      });
      const res = await db.query<{ id: string }>(INSERT, [
        r.organizationId,
        r.storeId,
        r.actorId,
        r.purpose,
        r.templateId,
        r.templateVersion,
        r.inputSha256,
        r.redactions,
        r.model,
        r.servedModel,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadTokens,
        r.costMicroUsd,
        r.latencyMs,
        r.outcome,
        r.errorClass,
      ]);
      return res.rows[0]!.id;
    },
  };
}
