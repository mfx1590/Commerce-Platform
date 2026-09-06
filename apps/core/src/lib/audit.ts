import type { Queryable } from '@platform/db';

/** Who performs a mutation. Resolved by the tenant middleware; `system` for jobs and bootstrap. */
export interface Actor {
  id: string | null;
  type: 'staff' | 'customer' | 'system';
  requestId?: string | null;
}

export const SYSTEM_ACTOR: Actor = { id: null, type: 'system' };

export interface AuditEntry {
  organizationId: string;
  storeId: string | null;
  actor: Actor;
  /** `<entity>.<verb>`, e.g. `store.update` */
  action: string;
  /** table name */
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Appends one `audit_log` row inside the caller's transaction (docs/domain.md: every admin mutation, before/after
 * JSON, same transaction). The table is append-only for the app role.
 *
 * Phase 1 stub: docs/domain.md assigns the shared writer helper to window 2 (@platform/auth-sdk). When it lands,
 * this function delegates to it behind the same signature.
 */
export async function writeAudit(tx: Queryable, entry: AuditEntry): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (organization_id, store_id, actor_id, actor_type, action, entity_type, entity_id, before, after, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      entry.organizationId,
      entry.storeId,
      entry.actor.id,
      entry.actor.type,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.actor.requestId ?? null,
    ],
  );
}
