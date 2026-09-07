// Read side of the audit log: GET /admin/audit-log (issue #14). Visibility is enforced by RLS through the
// caller's scoped client (store scope sees its stores' rows and never the store_id-IS-NULL rows;
// organization scope sees everything), so this is a plain filtered SELECT.
import type { ScopedClient } from '@platform/db';
import { ApiError } from '../types.js';
import type { AuditActorType } from './write.js';

export interface AuditLogFilters {
  storeId?: string | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  actorId?: string | undefined;
  /** ISO date-time bounds on created_at. */
  from?: string | undefined;
  to?: string | undefined;
  /** Only `created_at` exists in v0.1 (contract enum). */
  sort?: 'created_at' | undefined;
  order?: 'asc' | 'desc' | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export interface AuditLogEntry {
  id: string;
  store_id: string | null;
  actor_id: string | null;
  actor_type: AuditActorType;
  action: string;
  entity_type: string;
  entity_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  request_id: string | null;
  created_at: string;
}

export interface AuditLogPage {
  page: number;
  limit: number;
  total: number;
  items: AuditLogEntry[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseDate(value: string, field: string): string {
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    throw new ApiError(400, 'validation_error', `${field} must be an ISO date-time`, { field });
  }
  return new Date(t).toISOString();
}

/** Lists audit entries visible to the caller's scope. `db` must be the CALLER's scoped client (RLS). */
export async function listAuditLog(
  db: ScopedClient,
  f: AuditLogFilters = {},
): Promise<AuditLogPage> {
  const page = Math.max(1, Math.floor(f.page ?? 1));
  const limit = Math.min(100, Math.max(1, Math.floor(f.limit ?? 20)));
  if (f.sort !== undefined && f.sort !== 'created_at') {
    throw new ApiError(400, 'validation_error', 'sort must be created_at', { field: 'sort' });
  }
  const order = f.order === 'asc' ? 'ASC' : 'DESC';

  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  for (const [key, column] of [
    ['storeId', 'store_id'],
    ['entityId', 'entity_id'],
    ['actorId', 'actor_id'],
  ] as const) {
    const v = f[key];
    if (v === undefined) continue;
    if (!UUID.test(v)) {
      throw new ApiError(400, 'validation_error', `${column} must be a uuid`, { field: column });
    }
    add(`${column} = ?`, v);
  }
  if (f.entityType !== undefined) add('entity_type = ?', f.entityType);
  if (f.from !== undefined) add('created_at >= ?', parseDate(f.from, 'from'));
  if (f.to !== undefined) add('created_at <= ?', parseDate(f.to, 'to'));
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = await db.query<{ n: string }>(
    `SELECT count(*)::text n FROM audit_log ${whereSql}`,
    params,
  );
  const rows = await db.query<Omit<AuditLogEntry, 'created_at'> & { created_at: Date }>(
    `SELECT id, store_id, actor_id, actor_type, action, entity_type, entity_id, before, after, request_id, created_at
     FROM audit_log ${whereSql}
     ORDER BY created_at ${order}, id ${order}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, (page - 1) * limit],
  );
  return {
    page,
    limit,
    total: Number(total.rows[0]!.n),
    items: rows.rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
  };
}
