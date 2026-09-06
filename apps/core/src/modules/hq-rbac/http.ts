// Framework-neutral HTTP layer of hq-rbac. Window 1 mounts `handle()` (or the individual handlers) in the
// core's router; tests call it directly. Every handler re-checks the permission server-side (ADR 0002 §3).
import {
  ApiError,
  assignRole,
  forbidden,
  isApiError,
  isUuid,
  listAuditLog,
  listRoleAssignments,
  listStaffUsers,
  revokeRole,
  toTenantContext,
  type OpenFgaClient,
  type Relation,
  type RolesDeps,
  type StaffPrincipal,
  type StaffScope,
} from '@platform/auth-sdk';
import { createOrganizationClient, createTenantClient } from '@platform/db';

type Pool = Parameters<typeof createOrganizationClient>[0];

export interface HqRbacDeps {
  /** The application pool (`platform_app`); every query goes through the tenant client. */
  pool: Pool;
  /** OpenFGA client bound to the store + model (`createOpenFgaClient()`). */
  fga: OpenFgaClient;
  /** Scope-cache invalidation hook (task 1.4). */
  onRoleChange?: (staffUserId: string) => void;
}

export interface HqRbacRequest {
  method: string;
  /** Path without query string, e.g. `/admin/users/<id>/roles`. */
  path: string;
  /** null = no verified staff token → 401. */
  principal: StaffPrincipal | null;
  /** Full scope from the staff scope middleware (task 1.4); required by routes that list RLS-scoped data. */
  scope?: StaffScope | null;
  query?: Record<string, string | undefined>;
  body?: unknown;
  requestId?: string;
}

export interface HqRbacResponse {
  status: number;
  body?: unknown;
}

export interface Permission {
  relation: Relation | 'viewer';
  object: string;
}

export interface HqRbacRoute {
  method: 'GET' | 'POST' | 'DELETE';
  /** Contract path, `{param}` placeholders as in admin-api.yaml. */
  path: string;
  operationId: 'listUsers' | 'listUserRoles' | 'assignRole' | 'revokeRole' | 'listAuditLog';
  /** null = the handler checks dynamically (listAuditLog: viewer on store:{store_id} when given). */
  permission: Permission | null;
}

/** Mirrors the `x-permission` entries of packages/contracts admin-api.yaml for the routes this module owns. */
export const HQ_RBAC_ROUTES: readonly HqRbacRoute[] = [
  {
    method: 'GET',
    path: '/admin/users',
    operationId: 'listUsers',
    permission: { relation: 'owner', object: 'organization:hq' },
  },
  {
    method: 'GET',
    path: '/admin/users/{userId}/roles',
    operationId: 'listUserRoles',
    permission: { relation: 'owner', object: 'organization:hq' },
  },
  {
    method: 'POST',
    path: '/admin/users/{userId}/roles',
    operationId: 'assignRole',
    permission: { relation: 'owner', object: 'organization:hq' },
  },
  {
    method: 'DELETE',
    path: '/admin/users/{userId}/roles/{assignmentId}',
    operationId: 'revokeRole',
    permission: { relation: 'owner', object: 'organization:hq' },
  },
  {
    method: 'GET',
    path: '/admin/audit-log',
    operationId: 'listAuditLog',
    permission: null, // x-permission: viewer on store:{store_id} — checked in the handler (query-dependent)
  },
];

const error = (e: ApiError): HqRbacResponse => ({ status: e.status, body: e.toBody() });

/** Server-side permission check. Fails closed: OpenFGA unreachable → 503. */
async function requirePermission(
  fga: OpenFgaClient,
  principal: StaffPrincipal,
  permission: Permission,
): Promise<void> {
  let allowed: boolean;
  try {
    const res = await fga.check({
      user: `user:${principal.userId}`,
      relation: permission.relation,
      object: permission.object,
    });
    allowed = res.allowed === true;
  } catch {
    throw new ApiError(503, 'internal', 'authorization service unavailable');
  }
  if (!allowed) throw forbidden(permission.relation, permission.object);
}

function pathParams(routePath: string, actual: string): Record<string, string> | null {
  const a = routePath.split('/');
  const b = actual.replace(/\/+$/, '').split('/');
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const seg = a[i]!;
    const m = seg.match(/^\{(\w+)\}$/);
    if (m) params[m[1]!] = decodeURIComponent(b[i]!);
    else if (seg !== b[i]) return null;
  }
  return params;
}

export function createHqRbac(deps: HqRbacDeps) {
  const rolesDeps = (principal: StaffPrincipal, requestId?: string): RolesDeps => ({
    fga: deps.fga,
    db: createOrganizationClient(deps.pool, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
    }),
    requestId: requestId ?? null,
    ...(deps.onRoleChange ? { onChange: deps.onRoleChange } : {}),
  });

  const handlers = {
    async listUsers(req: HqRbacRequest & { principal: StaffPrincipal }): Promise<HqRbacResponse> {
      const q = req.query ?? {};
      const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
      if ([q.page, q.limit].some((v) => v !== undefined && !Number.isInteger(Number(v)))) {
        throw new ApiError(400, 'validation_error', 'page and limit must be integers');
      }
      const body = await listStaffUsers(rolesDeps(req.principal, req.requestId), {
        q: q.q,
        page: num(q.page),
        limit: num(q.limit),
      });
      return { status: 200, body };
    },

    async listUserRoles(
      req: HqRbacRequest & { principal: StaffPrincipal; params: { userId: string } },
    ): Promise<HqRbacResponse> {
      const items = await listRoleAssignments(
        rolesDeps(req.principal, req.requestId),
        req.params.userId,
      );
      return { status: 200, body: { items } };
    },

    async assignRole(
      req: HqRbacRequest & { principal: StaffPrincipal; params: { userId: string } },
    ): Promise<HqRbacResponse> {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b !== 'object' || b === null) {
        throw new ApiError(400, 'validation_error', 'body must be an object');
      }
      const { relation, object_type, object_id } = b;
      // validateAssignment (inside assignRole) turns bad values into 400s with the field name.
      const { assignment } = await assignRole(rolesDeps(req.principal, req.requestId), {
        staffUserId: req.params.userId,
        relation: relation as Relation,
        objectType: object_type as 'organization' | 'store',
        objectId: object_id as string,
      });
      return { status: 201, body: assignment };
    },

    async revokeRole(
      req: HqRbacRequest & {
        principal: StaffPrincipal;
        params: { userId: string; assignmentId: string };
      },
    ): Promise<HqRbacResponse> {
      await revokeRole(rolesDeps(req.principal, req.requestId), {
        staffUserId: req.params.userId,
        assignmentId: req.params.assignmentId,
      });
      return { status: 204 };
    },

    async listAuditLog(
      req: HqRbacRequest & { principal: StaffPrincipal },
    ): Promise<HqRbacResponse> {
      const scope = req.scope;
      if (!scope) throw new ApiError(401, 'unauthorized', 'Missing staff scope');
      const q = req.query ?? {};
      if (q.store_id !== undefined) {
        // x-permission: viewer on store:{store_id} when a store filter is given — re-checked server-side.
        if (!isUuid(q.store_id)) {
          throw new ApiError(400, 'validation_error', 'store_id must be a uuid', {
            field: 'store_id',
          });
        }
        await requirePermission(deps.fga, req.principal, {
          relation: 'viewer',
          object: `store:${q.store_id}`,
        });
      }
      // Without a store filter, visibility comes from RLS through the caller's own scope: organization
      // scope sees every row (store_id IS NULL included), store scope only its stores' rows.
      const ctx = toTenantContext(scope);
      if (ctx.scope === 'store' && ctx.storeIds.length === 0) {
        throw forbidden('viewer', 'store:*');
      }
      const db =
        ctx.scope === 'organization'
          ? createOrganizationClient(deps.pool, ctx)
          : createTenantClient(deps.pool, ctx);
      const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
      if ([q.page, q.limit].some((v) => v !== undefined && !Number.isInteger(Number(v)))) {
        throw new ApiError(400, 'validation_error', 'page and limit must be integers');
      }
      if (q.order !== undefined && q.order !== 'asc' && q.order !== 'desc') {
        throw new ApiError(400, 'validation_error', 'order must be asc or desc', {
          field: 'order',
        });
      }
      const body = await listAuditLog(db, {
        storeId: q.store_id,
        entityType: q.entity_type,
        entityId: q.entity_id,
        actorId: q.actor_id,
        from: q.from,
        to: q.to,
        sort: q.sort as 'created_at' | undefined,
        order: q.order,
        page: num(q.page),
        limit: num(q.limit),
      });
      return { status: 200, body };
    },
  };

  /**
   * Routes a request to the module's handlers. Returns null when the path is not one of this module's
   * (so the core can fall through). Auth: no principal → 401; permission → 403; OpenFGA down → 503.
   */
  async function handle(req: HqRbacRequest): Promise<HqRbacResponse | null> {
    let matched: { route: HqRbacRoute; params: Record<string, string> } | undefined;
    let pathKnown = false;
    for (const route of HQ_RBAC_ROUTES) {
      const params = pathParams(route.path, req.path);
      if (!params) continue;
      pathKnown = true;
      if (route.method === req.method.toUpperCase()) {
        matched = { route, params };
        break;
      }
    }
    if (!matched) {
      return pathKnown
        ? {
            status: 405,
            body: { code: 'validation_error', message: 'method not allowed', details: {} },
          }
        : null;
    }
    try {
      if (!req.principal) throw new ApiError(401, 'unauthorized', 'Missing bearer token');
      if (matched.route.permission) {
        await requirePermission(deps.fga, req.principal, matched.route.permission);
      }
      const params = matched.params;
      for (const [k, v] of Object.entries(params)) {
        if (!isUuid(v)) throw new ApiError(404, 'not_found', `${k} must be a uuid`);
      }
      const p = req.principal;
      switch (matched.route.operationId) {
        case 'listUsers':
          return await handlers.listUsers({ ...req, principal: p });
        case 'listUserRoles':
          return await handlers.listUserRoles({
            ...req,
            principal: p,
            params: { userId: params.userId! },
          });
        case 'assignRole':
          return await handlers.assignRole({
            ...req,
            principal: p,
            params: { userId: params.userId! },
          });
        case 'listAuditLog':
          return await handlers.listAuditLog({ ...req, principal: p });
        case 'revokeRole':
          return await handlers.revokeRole({
            ...req,
            principal: p,
            params: { userId: params.userId!, assignmentId: params.assignmentId! },
          });
      }
    } catch (err) {
      if (isApiError(err)) return error(err);
      return { status: 500, body: { code: 'internal', message: 'internal error', details: {} } };
    }
  }

  return { handle, handlers, routes: HQ_RBAC_ROUTES };
}
