// Role (tuple) management — ADR 0002 §7: OpenFGA first, then the role_assignment mirror and the audit row
// in one transaction; if the transaction fails the tuple change is compensated.
import type { OpenFgaClient, TupleKey } from '@openfga/sdk';
import { RELATIONS, type Relation } from '@platform/contracts';
import type { ScopedClient } from '@platform/db';
import { audit, type AuditActorType } from '../audit/write.js';
import { loadAuthorizationModel } from '../fga/model.js';
import { ApiError } from '../types.js';

export type ObjectType = 'organization' | 'store';
export const OBJECT_TYPES: readonly ObjectType[] = ['organization', 'store'];

export interface RoleAssignment {
  id: string;
  relation: Relation;
  object_type: ObjectType;
  object_id: string;
  created_at: string;
}

export interface StaffUser {
  id: string;
  email: string;
  display_name: string;
  status: 'active' | 'disabled';
  last_login_at: string | null;
}

export interface RolesDeps {
  /** Bound to the store (and ideally the model) — `createOpenFgaClient()`. */
  fga: OpenFgaClient;
  /** Organization-scoped client of the acting user (`createOrganizationClient`). actorId = the caller. */
  db: ScopedClient;
  /** Called after every successful change (scope-cache invalidation, task 1.4). */
  onChange?: (staffUserId: string) => void;
  requestId?: string | null;
}

export interface AssignRoleInput {
  staffUserId: string;
  relation: Relation;
  objectType: ObjectType;
  objectId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** Relations a `user` may hold directly per type, derived from model.fga (`[user]` in the definition). */
export const ASSIGNABLE_RELATIONS: Readonly<Record<ObjectType, ReadonlySet<Relation>>> = (() => {
  const model = loadAuthorizationModel();
  const forType = (type: ObjectType): ReadonlySet<Relation> => {
    const td = model.type_definitions.find((t) => t.type === type);
    const meta = td?.metadata?.relations ?? {};
    return new Set(
      Object.entries(meta)
        .filter(([, m]) => (m.directly_related_user_types ?? []).some((u) => u.type === 'user'))
        .map(([r]) => r)
        .filter((r): r is Relation => (RELATIONS as readonly string[]).includes(r)),
    );
  };
  return { organization: forType('organization'), store: forType('store') };
})();

interface Row {
  id: string;
  relation: Relation;
  object_type: ObjectType;
  object_id: string;
  created_at: Date;
}
const toApi = (r: Row): RoleAssignment => ({
  id: r.id,
  relation: r.relation,
  object_type: r.object_type,
  object_id: r.object_id,
  created_at: r.created_at.toISOString(),
});

function actorOf(db: ScopedClient): { id: string | null; type: AuditActorType } {
  const id = db.context.actorId ?? null;
  return { id, type: id ? 'staff' : 'system' };
}

/** Validates relation/object combination against the model and the contract. Throws 400. */
export function validateAssignment(input: {
  relation: unknown;
  objectType: unknown;
  objectId: unknown;
}): asserts input is { relation: Relation; objectType: ObjectType; objectId: string } {
  const { relation, objectType, objectId } = input;
  if (!(RELATIONS as readonly unknown[]).includes(relation)) {
    throw new ApiError(400, 'validation_error', `relation must be one of ${RELATIONS.join(', ')}`, {
      field: 'relation',
    });
  }
  if (!(OBJECT_TYPES as readonly unknown[]).includes(objectType)) {
    throw new ApiError(400, 'validation_error', 'object_type must be organization or store', {
      field: 'object_type',
    });
  }
  if (!isUuid(objectId)) {
    throw new ApiError(400, 'validation_error', 'object_id must be a uuid', { field: 'object_id' });
  }
  const allowed = ASSIGNABLE_RELATIONS[objectType as ObjectType];
  if (!allowed.has(relation as Relation)) {
    throw new ApiError(
      400,
      'validation_error',
      `${String(relation)} cannot be assigned directly on a ${String(objectType)} (model.fga allows: ${[...allowed].join(', ')})`,
      { field: 'relation', relation, object_type: objectType },
    );
  }
}

async function fgaObject(db: ScopedClient, objectType: ObjectType, objectId: string) {
  if (objectType === 'store') {
    const store = await db.query<{ id: string }>('SELECT id FROM store WHERE id = $1', [objectId]);
    if (store.rowCount === 0) {
      throw new ApiError(400, 'validation_error', 'object_id is not a store of this organization', {
        field: 'object_id',
      });
    }
    return `store:${objectId}`;
  }
  const org = await db.query<{ slug: string }>('SELECT slug FROM organization WHERE id = $1', [
    objectId,
  ]);
  if (org.rowCount === 0) {
    throw new ApiError(400, 'validation_error', "object_id must be the caller's organization", {
      field: 'object_id',
    });
  }
  return `organization:${org.rows[0]!.slug}`;
}

async function tupleExists(fga: OpenFgaClient, t: TupleKey): Promise<boolean> {
  const r = await fga.read({ user: t.user, relation: t.relation, object: t.object });
  return r.tuples.length > 0;
}
/** Writes the tuple unless present. Returns true when it was written by this call. */
async function ensureTuple(fga: OpenFgaClient, t: TupleKey): Promise<boolean> {
  if (await tupleExists(fga, t)) return false;
  await fga.write({ writes: [t] });
  return true;
}
/** Deletes the tuple if present. Returns true when it was deleted by this call. */
async function removeTuple(fga: OpenFgaClient, t: TupleKey): Promise<boolean> {
  if (!(await tupleExists(fga, t))) return false;
  await fga.write({ deletes: [t] });
  return true;
}

async function requireUser(db: ScopedClient, staffUserId: string): Promise<void> {
  if (!isUuid(staffUserId)) throw new ApiError(404, 'not_found', 'staff user not found');
  const u = await db.query('SELECT id FROM staff_user WHERE id = $1', [staffUserId]);
  if (u.rowCount === 0) throw new ApiError(404, 'not_found', 'staff user not found');
}

const SELECT_ROW = 'SELECT id, relation, object_type, object_id, created_at FROM role_assignment';

/**
 * Assign a relation. Idempotent: an existing assignment is returned with `created: false` (and its tuple
 * re-ensured). Order: tuple → (mirror row + audit) in one transaction → tuple removed if that fails.
 */
export async function assignRole(
  deps: RolesDeps,
  input: AssignRoleInput,
): Promise<{ assignment: RoleAssignment; created: boolean }> {
  validateAssignment(input);
  const { db, fga } = deps;
  await requireUser(db, input.staffUserId);
  const object = await fgaObject(db, input.objectType, input.objectId);
  const tuple: TupleKey = { user: `user:${input.staffUserId}`, relation: input.relation, object };

  const existing = await db.query<Row>(
    `${SELECT_ROW} WHERE staff_user_id = $1 AND relation = $2 AND object_type = $3 AND object_id = $4`,
    [input.staffUserId, input.relation, input.objectType, input.objectId],
  );
  if (existing.rowCount) {
    await ensureTuple(fga, tuple); // heal a missing tuple, never audit a no-op
    return { assignment: toApi(existing.rows[0]!), created: false };
  }

  const wroteTuple = await ensureTuple(fga, tuple);
  let row: Row;
  try {
    row = await db.transaction(async (tx) => {
      const ins = await tx.query<Row>(
        `INSERT INTO role_assignment (organization_id, staff_user_id, relation, object_type, object_id)
         VALUES (app.current_organization_id(), $1, $2, $3, $4)
         ON CONFLICT (staff_user_id, relation, object_type, object_id) DO UPDATE SET updated_at = now()
         RETURNING id, relation, object_type, object_id, created_at`,
        [input.staffUserId, input.relation, input.objectType, input.objectId],
      );
      const r = ins.rows[0]!;
      await audit(tx, {
        action: 'role_assignment.create',
        entityType: 'role_assignment',
        entityId: r.id,
        before: null,
        after: { ...toApi(r), staff_user_id: input.staffUserId },
        storeId: input.objectType === 'store' ? input.objectId : null,
        actor: actorOf(db),
        requestId: deps.requestId ?? null,
      });
      return r;
    });
  } catch (err) {
    if (wroteTuple) await removeTuple(fga, tuple).catch(() => undefined);
    throw err;
  }
  deps.onChange?.(input.staffUserId);
  return { assignment: toApi(row), created: true };
}

/** Revoke by assignment id. Order: tuple deleted → (row deleted + audit) → tuple restored if that fails. */
export async function revokeRole(
  deps: RolesDeps,
  input: { staffUserId: string; assignmentId: string },
): Promise<void> {
  const { db, fga } = deps;
  await requireUser(db, input.staffUserId);
  if (!isUuid(input.assignmentId))
    throw new ApiError(404, 'not_found', 'role assignment not found');
  const found = await db.query<Row>(`${SELECT_ROW} WHERE id = $1 AND staff_user_id = $2`, [
    input.assignmentId,
    input.staffUserId,
  ]);
  if (!found.rowCount) throw new ApiError(404, 'not_found', 'role assignment not found');
  const row = found.rows[0]!;
  const object = await fgaObject(db, row.object_type, row.object_id);
  const tuple: TupleKey = { user: `user:${input.staffUserId}`, relation: row.relation, object };

  const deletedTuple = await removeTuple(fga, tuple);
  try {
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM role_assignment WHERE id = $1', [row.id]);
      await audit(tx, {
        action: 'role_assignment.delete',
        entityType: 'role_assignment',
        entityId: row.id,
        before: { ...toApi(row), staff_user_id: input.staffUserId },
        after: null,
        storeId: row.object_type === 'store' ? row.object_id : null,
        actor: actorOf(db),
        requestId: deps.requestId ?? null,
      });
    });
  } catch (err) {
    if (deletedTuple) await ensureTuple(fga, tuple).catch(() => undefined);
    throw err;
  }
  deps.onChange?.(input.staffUserId);
}

export async function listRoleAssignments(
  deps: Pick<RolesDeps, 'db'>,
  staffUserId: string,
): Promise<RoleAssignment[]> {
  await requireUser(deps.db, staffUserId);
  const rows = await deps.db.query<Row>(
    `${SELECT_ROW} WHERE staff_user_id = $1 ORDER BY created_at, id`,
    [staffUserId],
  );
  return rows.rows.map(toApi);
}

export async function listStaffUsers(
  deps: Pick<RolesDeps, 'db'>,
  opts: { q?: string | undefined; page?: number | undefined; limit?: number | undefined } = {},
): Promise<{ page: number; limit: number; total: number; items: StaffUser[] }> {
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 20)));
  const q = opts.q?.trim() ? `%${opts.q.trim()}%` : null;
  const where = q ? 'WHERE email ILIKE $1 OR display_name ILIKE $1' : '';
  const params: unknown[] = q ? [q] : [];
  const total = await deps.db.query<{ n: string }>(
    `SELECT count(*)::text n FROM staff_user ${where}`,
    params,
  );
  const items = await deps.db.query<{
    id: string;
    email: string;
    display_name: string;
    status: 'active' | 'disabled';
    last_login_at: Date | null;
  }>(
    `SELECT id, email, display_name, status, last_login_at FROM staff_user ${where}
     ORDER BY email LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, (page - 1) * limit],
  );
  return {
    page,
    limit,
    total: Number(total.rows[0]!.n),
    items: items.rows.map((r) => ({ ...r, last_login_at: r.last_login_at?.toISOString() ?? null })),
  };
}
