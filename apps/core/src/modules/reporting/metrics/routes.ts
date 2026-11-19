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
//
// BI v2 (#871): `queryMetrics` gains labels (names resolved from Postgres under the caller's scope), the `stock` series
// scope (organization, or the stock items the caller's stores map) and the CSV labels opt-in (`?labels=true`); two
// operations join it, `listMetricMovers` and `getInventoryHealth`. Until #871's contract lands they answer 503 like
// any operation the spec lacks.
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
import { organizationClient } from '../../../lib/db';
import { AppError } from '../../../lib/errors';
import { catalogueFor, METRICS } from './catalogue';
import type { StockScope } from './compile';
import { renderInventoryCsv, renderMetricCsv } from './csv';
import { executeMetricQuery, type MetricsReader } from './execute';
import {
  computeInventoryHealth,
  loadInventoryInputs,
  parseInventoryQuery,
  type InventoryQuery,
} from './inventory';
import { idsOf, resolveLabels } from './labels';
import { listMetricMovers, parseMoversQuery } from './movers';
import { promotionsLoader } from './promotions';
import { parseMetricQuery, type MetricQuery } from './query';
import { sharedMetricsReader } from './reader';
import { scopeForQuery } from './scope';

export const METRICS_PATH = '/admin/metrics';
export const METRICS_QUERY_PATH = '/admin/metrics/query';
export const METRICS_MOVERS_PATH = '/admin/metrics/movers';
export const METRICS_INVENTORY_PATH = '/admin/metrics/inventory';

type Operation = 'listMetrics' | 'queryMetrics' | 'listMetricMovers' | 'getInventoryHealth';
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

/** Stock items a store-scoped series can carry (#908: one ClickHouse parameter holds ~128 KB, about 3 000 ids). */
export const MAX_STOCK_SCOPE_ITEMS = 2500;

/** The clear refusal a store-scoped stock series gets above that, before any ClickHouse call (#908). */
export function stockScopeTooLarge(items: number): AppError {
  return new AppError(
    'validation_error',
    `this store sells from ${items} stock items; a store-scoped stock series covers at most ${MAX_STOCK_SCOPE_ITEMS} for now (#908) — HQ's view covers every store`,
    { reason: 'stock_scope_too_large', items, max: MAX_STOCK_SCOPE_ITEMS },
  );
}

/**
 * The `stock` series scope (#871 c): an organization caller reads the organization (narrowed to the stock items of
 * `store_ids` when given); a store caller the stock items its stores' variants map, read under RLS. Above
 * MAX_STOCK_SCOPE_ITEMS a clear 400 instead of ClickHouse's "field value too long" (#908).
 */
export async function stockScopeFor(
  p: StaffPrincipal,
  stores: readonly string[],
  narrowed: boolean,
): Promise<StockScope> {
  if (hasOrganizationAccess(p) && !narrowed) return { organizationId: p.organizationId };
  const r = await visibleStoresClientFor(p).query<{ id: string }>(
    'SELECT DISTINCT stock_item_id::text AS id FROM product_variant WHERE store_id = ANY($1::uuid[])',
    [[...stores]],
  );
  if (r.rows.length > MAX_STOCK_SCOPE_ITEMS) throw stockScopeTooLarge(r.rows.length);
  return { stockItemIds: r.rows.map((x) => x.id) };
}

const usesStock = (q: MetricQuery) => q.metrics.some((m) => METRICS[m].source?.id === 'stock');
const wantsCsv = (req: Request) => req.accepts(['application/json', 'text/csv']) === 'text/csv';
const labelsParam = (req: Request) => req.query.labels === 'true' || req.query.labels === '1';

/**
 * The x-permission guard of an operation, resolved from the spec per request (cached once found). An operation the
 * spec does not have FAILS CLOSED: a 503 `unavailable` before anything runs, never an unguarded route. Shared with
 * BI Q&A's routes (../ask/routes.ts).
 */
export function operationGuard(spec: MetricsSpec): (op: string) => RequestHandler {
  const guards = new Map<string, RequestHandler>();
  return (op) => (req, res, next) => {
    let g = guards.get(op);
    if (!g) {
      let perm: PermissionSpec;
      try {
        perm = spec.permission(op);
      } catch {
        next(new AppError('unavailable', `${op} is not in the contract`, { operation: op }));
        return;
      }
      g = requirePermission(perm.relation as never, (r: Request) =>
        resolveObject(perm.object, r.params),
      );
      guards.set(op, g);
    }
    g(req, res, next);
  };
}

export function metricsAdminRouter(opts: MetricsRouterOptions = {}): Router {
  const spec: MetricsSpec = opts.spec ?? loadSpec('admin-api.yaml');
  const reader = (): MetricsReader => opts.reader ?? sharedMetricsReader();
  const guard: (op: Operation) => RequestHandler = operationGuard(spec);
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
      // #935 (manager decision): JSON answers at most LIMITS.max_rows rows; text/csv up to LIMITS.max_csv_rows
      const csv = wantsCsv(req);
      const q = parseMetricQuery(req.body, { csv });
      // the same rules BI Q&A's tool applies (scope.ts): 403 outside the scope, never empty rows
      const scope = await scopeForQuery(q, {
        stores: (await metricsScope(p)).map((s) => s.id),
        finance: () => can(p, 'finance', 'organization:hq'),
      });
      const stock = usesStock(q)
        ? await stockScopeFor(p, scope, q.filters.store_ids !== undefined)
        : undefined;
      const result = await executeMetricQuery(reader(), q, scope, {
        ...(stock ? { stock } : {}),
        promotions: promotionsLoader(visibleStoresClientFor(p)),
      });
      result.labels = await resolveLabels(
        visibleStoresClientFor(p),
        idsOf([...result.rows, ...(result.compare?.rows ?? [])]),
      );
      // text/csv only when the client prefers it over JSON (the default stays JSON); errors stay JSON either way
      if (csv) {
        res
          .status(200)
          .type('text/csv; charset=utf-8')
          .set('X-Truncated', String(result.truncated))
          .send(renderMetricCsv(result, { labels: labelsParam(req) }));
        return;
      }
      res.json(result);
    }),
  );

  r.post(
    METRICS_MOVERS_PATH,
    guard('listMetricMovers'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      spec.validateBody('listMetricMovers', req.body);
      const mq = parseMoversQuery(req.body);
      // the same scope and finance rules as queryMetrics (scope.ts), on the equivalent period query
      const scope = await scopeForQuery(
        {
          metrics: [mq.metric],
          dimensions: [mq.dimension],
          grain: 'total',
          from: mq.from,
          to: mq.to,
          filters: mq.filters,
          limit: 1,
        },
        {
          stores: (await metricsScope(p)).map((s) => s.id),
          finance: () => can(p, 'finance', 'organization:hq'),
        },
      );
      const result = await listMetricMovers(reader(), mq, scope);
      const keys = result.by_currency.flatMap((b) => [...b.risers, ...b.fallers]).map((m) => m.key);
      const column = {
        store: 'store_id',
        country: 'country',
        sales_channel: 'sales_channel_id',
        product: 'product_id',
        category: 'category_id',
      }[mq.dimension];
      res.json({
        ...result,
        labels: await resolveLabels(
          visibleStoresClientFor(p),
          idsOf(keys.map((k) => ({ [column]: k }))),
        ),
      });
    }),
  );

  r.post(
    METRICS_INVENTORY_PATH,
    guard('getInventoryHealth'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      spec.validateBody('getInventoryHealth', req.body ?? {});
      const q: InventoryQuery = parseInventoryQuery(req.body ?? {});
      const visible = (await metricsScope(p)).map((s) => s.id);
      if (visible.length === 0)
        throw forbidden('no visible store', { relation: 'viewer', object: 'store:*' });
      for (const id of q.store_ids ?? [])
        if (!visible.includes(id))
          throw forbidden(`requires viewer on store:${id}`, {
            relation: 'viewer',
            object: `store:${id}`,
          });
      const stores = q.store_ids ?? visible;
      const organization = hasOrganizationAccess(p);
      const now = new Date();
      const inputs = await loadInventoryInputs(
        {
          pg: visibleStoresClientFor(p),
          // one organization-level fact for a store caller: does another store sell from this item (a boolean)
          ...(organization
            ? {}
            : {
                orgPg: organizationClient({ organizationId: p.organizationId, actorId: p.user.id }),
              }),
          reader: reader(),
          organizationId: p.organizationId,
          stores,
          rateStores: stores,
          organization,
          now,
        },
        q,
      );
      // a warehouse, category or product filter outside what the caller can see is a 403, never a silent narrowing
      const seen = {
        warehouse: new Set(inputs.positions.map((x) => x.warehouse_id)),
        category: new Set(
          inputs.mappings.map((x) => x.category_id).filter((x): x is string => x !== null),
        ),
        product: new Set(inputs.mappings.map((x) => x.product_id)),
      };
      for (const [field, ids, kind] of [
        ['warehouse_ids', q.warehouse_ids, 'warehouse'],
        ['category_ids', q.category_ids, 'category'],
        ['product_ids', q.product_ids, 'product'],
      ] as const)
        for (const id of ids ?? [])
          if (!seen[kind].has(id))
            throw forbidden(`${field}: ${id} is outside your scope`, {
              field,
              object: `${kind}:${id}`,
            });
      const result = computeInventoryHealth(inputs, q, { organization, now });
      if (wantsCsv(req)) {
        res
          .status(200)
          .type('text/csv; charset=utf-8')
          .set('X-Total', String(result.total))
          .send(renderInventoryCsv(result));
        return;
      }
      res.json(result);
    }),
  );

  return r;
}
