// One audit record per gateway call (D8, #605) — NEVER the content: no prompt, no variable, no output. The table
// (`ai_call_audit`) is a CONTRACT CHANGE landed by the manager; until then the gateway writes through `AuditSink`
// and tests use the in-memory sink. A Postgres sink over the tenant client follows the landing.
import type { Purpose } from './models.js';

export const OUTCOMES = [
  'ok',
  'refused',
  'max_tokens',
  'error',
  'disabled',
  'over_budget',
  'rate_limited',
  'denied_field',
] as const;
export type AuditOutcome = (typeof OUTCOMES)[number];

export interface AuditRecord {
  organizationId: string;
  storeId: string;
  /** staff_user.id of the person who asked; null for a job. */
  actorId: string | null;
  purpose: Purpose;
  templateId: string;
  templateVersion: number;
  /** sha256 (hex) of the REDACTED rendered input; empty string when nothing was rendered. */
  inputSha256: string;
  redactions: number;
  model: string;
  servedModel: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costMicroUsd: number;
  latencyMs: number | null;
  outcome: AuditOutcome;
  /** An error CLASS name only, never a message. */
  errorClass: string | null;
}

export interface AuditSink {
  /** Persists one record; returns its id. */
  write(record: AuditRecord): Promise<string>;
}

export interface MemoryAuditSink extends AuditSink {
  readonly records: ReadonlyArray<AuditRecord & { id: string }>;
}

export function createMemoryAuditSink(): MemoryAuditSink {
  const records: Array<AuditRecord & { id: string }> = [];
  return {
    records,
    async write(record) {
      const id = crypto.randomUUID();
      records.push({ ...record, id });
      return id;
    },
  };
}
