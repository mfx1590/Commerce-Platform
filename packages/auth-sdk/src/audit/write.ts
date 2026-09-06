// Append-only audit writer. Takes the caller's transaction (`Queryable` from @platform/db) and never opens a
// connection: the row is committed or rolled back together with the change it describes.
// organization_id comes from the transaction's tenant context (app.current_organization_id()).
// before/after snapshots are PII-redacted (redact.ts) before they are stored.
import type { Queryable } from '@platform/db';
import { redactPii } from './redact.js';

export type AuditActorType = 'staff' | 'customer' | 'system';

export interface AuditEntry {
  /** `<entity>.<verb>`, e.g. `role_assignment.create`. */
  action: string;
  /** Table name. */
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  /** null/undefined for organization-level actions. */
  storeId?: string | null;
  actor: { id: string | null; type: AuditActorType };
  requestId?: string | null;
}

export async function audit(tx: Queryable, entry: AuditEntry): Promise<{ id: string }> {
  const res = await tx.query<{ id: string }>(
    `INSERT INTO audit_log
       (organization_id, store_id, actor_id, actor_type, action, entity_type, entity_id, before, after, request_id)
     VALUES (app.current_organization_id(), $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
     RETURNING id`,
    [
      entry.storeId ?? null,
      entry.actor.id,
      entry.actor.type,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.before === undefined || entry.before === null
        ? null
        : JSON.stringify(redactPii(entry.before)),
      entry.after === undefined || entry.after === null
        ? null
        : JSON.stringify(redactPii(entry.after)),
      entry.requestId ?? null,
    ],
  );
  return { id: res.rows[0]!.id };
}
