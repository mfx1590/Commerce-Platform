// Express adapter for window 2's framework-neutral hq-rbac module (src/modules/hq-rbac, read-only for us):
// `/admin/users`, `/admin/users/{id}/roles`, `/admin/audit-log`, `/admin/finance/ping`. Mounted by
// mountCoreMiddleware after `staffAuthMiddleware` and the JSON body parser, ahead of `adminRouter()`: the module
// receives the principal and scope the middleware already resolved (no second token verification) and
// re-checks every permission against OpenFGA itself (503 fail closed). `null` from `handle()` = not one of its
// paths → `next()`.
import type { RequestHandler } from 'express';
import type { OpenFgaClient } from '@platform/auth-sdk';
import { createHqRbac } from '../modules/hq-rbac';
import { getPool } from '../lib/db';
import { one } from './query';
import { requestIdOf } from './request-id';
import { principalScope } from './staff-auth';

export interface HqRbacAdapterOptions {
  /** OpenFGA client for the module's own permission checks (the same one the staff verifier uses). */
  fga: OpenFgaClient;
  /** Scope-cache invalidation on role changes (`KeycloakStaffTokenVerifier.invalidate`). */
  onRoleChange?: (staffUserId: string) => void;
}

export function hqRbacAdapter(opts: HqRbacAdapterOptions): RequestHandler {
  // Built on first request so the pool (src/lib/db.ts) may be opened after the app is assembled.
  let rbac: ReturnType<typeof createHqRbac> | undefined;
  return (req, res, next) => {
    if (!req.path.startsWith('/admin/')) return next();
    rbac ??= createHqRbac({
      pool: getPool(),
      fga: opts.fga,
      ...(opts.onRoleChange ? { onRoleChange: opts.onRoleChange } : {}),
    });
    const p = req.principal;
    const query: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.query)) query[k] = one(v);
    rbac
      .handle({
        method: req.method,
        path: req.path,
        principal: p
          ? {
              userId: p.user.id,
              subject: p.subject,
              organizationId: p.organizationId,
              email: p.user.email,
            }
          : null,
        scope: p ? principalScope(p) : null,
        query,
        body: req.body,
        requestId: requestIdOf(req),
      })
      .then((out) => {
        if (!out) return next();
        res.status(out.status);
        if (out.body === undefined) res.end();
        else res.json(out.body);
      })
      .catch(next);
  };
}
