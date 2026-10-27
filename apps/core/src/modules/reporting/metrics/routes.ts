// The two metrics operations (#603, D4): `listMetrics` (GET /admin/metrics) and `queryMetrics`
// (POST /admin/metrics/query), both `viewer` on `store:*` (listStores' check: any visible store).
//
//   * SCOPE comes from the server, never the request: an HQ principal (any organization relation: all five imply
//     store viewer in infra/openfga/model.fga) sees every store of the organization; anyone else the stores they view
//     (the OpenFGA scope for real tokens, role_assignment for dev tokens). It is injected into every compiled query.
//   * A `filters.store_ids` entry outside the scope is a 403 (never empty rows); a finance metric without `finance` on
//     organization:hq is a 403; no visible store at all is a 403.
//   * There is no SQL input anywhere: the body is a closed-vocabulary MetricQuery (query.ts) compiled by compile.ts.
//
// The operations' x-permission is read from admin-api.yaml at construction, as every module router does; until the
// contract lands (integration/phase5-metrics) the two routes answer 503 (fail closed; tests inject the spec).
import { Router, type Request, type RequestHandler } from 'express';
import {
  can,
  handle,
  hasOrganizationAccess,
  loadSpec,
  organizationClientFor,
  requirePermission,
  requirePrincipal,
  resolveObject,
  visibleStoreIds,
  visibleStoresClientFor,
} from '../../../http';
import { AppError } from '../../../lib/errors';
import { catalogueFor, METRICS } from './catalogue';
import { executeMetricQuery, type MetricsReader } from './execute';
import { parseMetricQuery } from './query';
import { sharedMetricsReader } from './reader';

export const METRICS_PATH = '/admin/metrics';
export const METRICS_QUERY_PATH = '/admin/metrics/query';

type Operation = 'listMetrics' | 'queryMetrics';
type PermissionSpec = { relation: string; object: string };

/** The slice of the loaded spec the router uses (tests replace it to prove the fail-closed path). */
export interface MetricsSpec {
  permission(operationId: string): PermissionSpec;
  validateBody(operationId: string, body: unknown): void;
}

export interface MetricsRouterOptions {
  /** The read-only ClickHouse client (analytics_ro); created from the environment on first use when omitted. */
  reader?: MetricsReader;
  /** admin-api.yaml when omitted. */
  spec?: MetricsSpec;
}

type StaffPrincipal = ReturnType<typeof requirePrincipal>;

/** The caller's scope: the stores they may view, with their codes (the catalogue lists them). */
export async function metricsScope(p: StaffPrincipal): Promise<{ id: string; code: string }[]> {
  if (hasOrganizationAccess(p)) {
    const r = await organizationClientFor(p).query<{ id: string; code: string }>(
      'SELECT id, code FROM store ORDER BY code, id',
    );
    return r.rows;
  }
  const ids = visibleStoreIds(p);
  if (ids.length === 0) return [];
  const r = await visibleStoresClientFor(p).query<{ id: string; code: string }>(
    'SELECT id, code FROM store WHERE id = ANY($1::uuid[]) ORDER BY code, id',
    [ids],
  );
  return r.rows;
}

const forbidden = (message: string, details: Record<string, unknown>) =>
  new AppError('forbidden', message, details);

export function metricsAdminRouter(opts: MetricsRouterOptions = {}): Router {
  const spec: MetricsSpec = opts.spec ?? loadSpec('admin-api.yaml');
  const reader = (): MetricsReader => opts.reader ?? sharedMetricsReader();
  // x-permission is resolved per request (cached once found), and an operation the spec does not have FAILS CLOSED:
  // a 503 before anything runs, never an unguarded route (the contract lands on integration/phase5-metrics).
  const guards = new Map<Operation, RequestHandler>();
  const guard =
    (op: Operation): RequestHandler =>
    (req, res, next) => {
      let g = guards.get(op);
      if (!g) {
        let perm: PermissionSpec;
        try {
          perm = spec.permission(op);
        } catch {
          next(new AppError('internal', `${op} is not in the contract`, { operation: op }, 503));
          return;
        }
        g = requirePermission(perm.relation as never, (r: Request) =>
          resolveObject(perm.object, r.params),
        );
        guards.set(op, g);
      }
      g(req, res, next);
    };
  const r = Router();

  r.get(
    METRICS_PATH,
    guard('listMetrics'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const stores = await metricsScope(p);
      if (stores.length === 0)
        throw forbidden('no visible store', { relation: 'viewer', object: 'store:*' });
      res.json(catalogueFor({ finance: await can(p, 'finance', 'organization:hq'), stores }));
    }),
  );

  r.post(
    METRICS_QUERY_PATH,
    guard('queryMetrics'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      spec.validateBody('queryMetrics', req.body);
      const q = parseMetricQuery(req.body);
      const stores = (await metricsScope(p)).map((s) => s.id);
      if (stores.length === 0)
        throw forbidden('no visible store', { relation: 'viewer', object: 'store:*' });
      const inScope = new Set(stores);
      for (const id of q.filters.store_ids ?? [])
        if (!inScope.has(id))
          throw forbidden(`requires viewer on store:${id}`, {
            relation: 'viewer',
            object: `store:${id}`,
          });
      const finance = q.metrics.filter((m) => METRICS[m].finance);
      if (finance.length > 0 && !(await can(p, 'finance', 'organization:hq')))
        throw forbidden(`${finance[0]} requires finance on organization:hq`, {
          relation: 'finance',
          object: 'organization:hq',
          metric: finance[0],
        });
      const scope = q.filters.store_ids ?? stores;
      res.json(await executeMetricQuery(reader(), q, scope));
    }),
  );

  return r;
}
