// Admin API routes window 1 owns in Phase 1 (packages/contracts/openapi/admin-api.yaml): /admin/me, registry
// (stores, domains, sales channels, api keys, warehouses, legal entities) and catalog (categories, products,
// variants). Every handler: validate → x-permission (read from the spec) → scoped client → module → respond.
// Mounted by mountCoreMiddleware AHEAD of Medusa (same reasons as the Store API routes). Everything else on the
// Admin API stays on the Prism mock (:4011).
import { Router, type RequestHandler } from 'express';
import type { AdminComponents } from '@platform/contracts';
import type { ScopedClient } from '@platform/db';
import {
  archiveProduct,
  createCategory,
  createProduct,
  createVariant,
  getProduct,
  listCategories,
  listProducts,
  publishProduct,
  updateProduct,
  updateVariant,
  type ProductStatus,
} from '../modules/catalog';
import {
  addDomain,
  createApiKey,
  createSalesChannel,
  createStore,
  getStore,
  listApiKeys,
  listDomains,
  listLegalEntities,
  listSalesChannels,
  listStores,
  listWarehouses,
  updateStore,
} from '../modules/registry';
import { organizationClient } from '../lib/db';
import { handle } from './errors';
import { loadSpec } from './openapi';
import { requirePermission, resolveObject } from './permissions';
import { one, pageParams, throwIfProblems, uuidParam } from './query';
import {
  organizationClientFor,
  requirePrincipal,
  storeClientFor,
  visibleStoresClientFor,
  type StaffPrincipal,
} from './staff-auth';

type Principal = AdminComponents['schemas']['Principal'];
const PRODUCT_STATUSES: readonly ProductStatus[] = ['draft', 'published', 'archived'];

/**
 * Runs the operation's `x-permission` from admin-api.yaml against the principal, validates the JSON body against
 * the operation's request schema, and returns the principal. `storeId` fills the `store:{storeId}` template.
 */
function guard(
  req: Parameters<RequestHandler>[0],
  operationId: string,
  storeId?: string,
  body?: unknown,
): StaffPrincipal {
  const spec = loadSpec('admin-api.yaml');
  const p = requirePrincipal(req);
  const perm = spec.permission(operationId);
  requirePermission(p, perm.relation, resolveObject(perm.object, { storeId }));
  if (body !== undefined) spec.validateBody(operationId, body);
  return p;
}

/** Store-scoped client for an admin request; `storeId` comes from the path. */
function storeClient(p: StaffPrincipal, storeId: string): ScopedClient {
  return storeClientFor(p, storeId);
}

export function adminRouter(): Router {
  const r = Router();

  // ---- me --------------------------------------------------------------------------------------------------
  r.get(
    '/admin/me',
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const org = await organizationClient({ organizationId: p.organizationId }).query<{
        id: string;
        slug: string;
        name: string;
      }>('SELECT id, slug, name FROM organization WHERE id = $1', [p.organizationId]);
      const organization = org.rows[0] ?? { id: p.organizationId, slug: 'hq', name: 'HQ' };
      const body: Principal = {
        user: p.user,
        organization,
        organization_relations: p.organizationRelations,
        stores: p.stores,
      };
      res.json(body);
    }),
  );

  // ---- registry: stores ------------------------------------------------------------------------------------
  r.get(
    '/admin/stores',
    handle(async (req, res) => {
      const p = guard(req, 'listStores');
      const problems: Record<string, string> = {};
      const page = pageParams(req.query, 20, problems);
      throwIfProblems(problems);
      res.json(await listStores(visibleStoresClientFor(p), page));
    }),
  );
  r.post(
    '/admin/stores',
    handle(async (req, res) => {
      const p = guard(req, 'createStore', undefined, req.body);
      res.status(201).json(await createStore(organizationClientFor(p), req.body, p.actor));
    }),
  );
  r.get(
    '/admin/stores/:storeId',
    handle(async (req, res) => {
      const storeId = uuidParam(req.params, 'storeId');
      const p = guard(req, 'getStore', storeId);
      res.json(await getStore(storeClient(p, storeId), storeId));
    }),
  );
  r.patch(
    '/admin/stores/:storeId',
    handle(async (req, res) => {
      const storeId = uuidParam(req.params, 'storeId');
      const p = guard(req, 'updateStore', storeId, req.body);
      res.json(await updateStore(storeClient(p, storeId), storeId, req.body, p.actor));
    }),
  );

  // ---- registry: domains, sales channels, api keys ---------------------------------------------------------
  r.get(
    '/admin/stores/:storeId/domains',
    handle(async (req, res) => {
      const storeId = uuidParam(req.params, 'storeId');
      const p = guard(req, 'listDomains', storeId);
      res.json({ items: await listDomains(storeClient(p, storeId), storeId) });
    }),
  );
  r.post(
    '/admin/stores/:storeId/domains',
    handle(async (req, res) => {
      const storeId = uuidParam(req.params, 'storeId');
      const p = guard(req, 'addDomain', storeId, req.body);
      res.status(201).json(await addDomain(storeClient(p, storeId), storeId, req.body, p.actor));
    }),
  );
  r.get(
    '/admin/stores/:storeId/sales-channels',
    handle(async (req, res) => {
      const storeId = uuidParam(req.params, 'storeId');
      const p = guard(req, 'listSalesChannels', storeId);
      res.json({ items: await listSalesChannels(storeClient(p, storeId), storeId) });
    }),
  );
  r.post(
    '/admin/stores/:storeId/sales-channels',
    handle(async (req, res) => {
      const storeId = uuidParam(req.params, 'storeId');
      const p = guard(req, 'createSalesChannel', storeId, req.body);
      res
        .status(201)
        .json(await createSalesChannel(storeClient(p, storeId), storeId, req.body, p.actor));
    }),
  );
  r.get(
    '/admin/stores/:storeId/api-keys',
    handle(async (req, res) => {
      const storeId = uuidParam(req.params, 'storeId');
      const p = guard(req, 'listApiKeys', storeId);
      res.json({ items: await listApiKeys(storeClient(p, storeId), storeId) });
    }),
  );
  r.post(
    '/admin/stores/:storeId/api-keys',
    handle(async (req, res) => {
      const storeId = uuidParam(req.params, 'storeId');
      const p = guard(req, 'createApiKey', storeId, req.body);
      res.status(201).json(await createApiKey(storeClient(p, storeId), storeId, req.body, p.actor));
    }),
  );

  // ---- registry: organization level ------------------------------------------------------------------------
  r.get(
    '/admin/warehouses',
    handle(async (req, res) => {
      const p = guard(req, 'listWarehouses');
      res.json({ items: await listWarehouses(organizationClientFor(p)) });
    }),
  );
  r.get(
    '/admin/legal-entities',
    handle(async (req, res) => {
      const p = guard(req, 'listLegalEntities');
      res.json({ items: await listLegalEntities(organizationClientFor(p)) });
    }),
  );

  // ---- catalog: categories ---------------------------------------------------------------------------------
  r.get(
    '/admin/stores/:storeId/categories',
    handle(async (req, res) => {
      const storeId = uuidParam(req.params, 'storeId');
      const p = guard(req, 'listCategories', storeId);
      res.json({ items: await listCategories(storeClient(p, storeId), storeId) });
    }),
  );
  r.post(
    '/admin/stores/:storeId/categories',
    handle(async (req, res) => {
      const storeId = uuidParam(req.params, 'storeId');
      const p = guard(req, 'createCategory', storeId, req.body);
      res
        .status(201)
        .json(await createCategory(storeClient(p, storeId), storeId, req.body, p.actor));
    }),
  );

  // ---- catalog: products -----------------------------------------------------------------------------------
  r.get(
    '/admin/stores/:storeId/products',
    handle(async (req, res) => {
      const storeId = uuidParam(req.params, 'storeId');
      const p = guard(req, 'listProducts', storeId);
      const problems: Record<string, string> = {};
      const page = pageParams(req.query, 20, problems);
      const status = one(req.query.status);
      if (status !== undefined && !PRODUCT_STATUSES.includes(status as ProductStatus)) {
        problems.status = `one of ${PRODUCT_STATUSES.join(', ')}`;
      }
      const categoryId = one(req.query.category_id);
      if (categoryId !== undefined && !/^[0-9a-f-]{36}$/i.test(categoryId))
        problems.category_id = 'uuid';
      throwIfProblems(problems);
      res.json(
        await listProducts(storeClient(p, storeId), storeId, {
          ...page,
          q: one(req.query.q),
          ...(status ? { status: status as ProductStatus } : {}),
          ...(categoryId ? { category_id: categoryId } : {}),
        }),
      );
    }),
  );
  r.post(
    '/admin/stores/:storeId/products',
    handle(async (req, res) => {
      const storeId = uuidParam(req.params, 'storeId');
      const p = guard(req, 'createProduct', storeId, req.body);
      res
        .status(201)
        .json(await createProduct(storeClient(p, storeId), storeId, req.body, p.actor));
    }),
  );
  r.get(
    '/admin/stores/:storeId/products/:productId',
    handle(async (req, res) => {
      const storeId = uuidParam(req.params, 'storeId');
      const productId = uuidParam(req.params, 'productId');
      const p = guard(req, 'getProduct', storeId);
      res.json(await getProduct(storeClient(p, storeId), storeId, productId));
    }),
  );
  r.patch(
    '/admin/stores/:storeId/products/:productId',
    handle(async (req, res) => {
      const storeId = uuidParam(req.params, 'storeId');
      const productId = uuidParam(req.params, 'productId');
      const p = guard(req, 'updateProduct', storeId, req.body);
      res.json(await updateProduct(storeClient(p, storeId), storeId, productId, req.body, p.actor));
    }),
  );
  r.delete(
    '/admin/stores/:storeId/products/:productId',
    handle(async (req, res) => {
      const storeId = uuidParam(req.params, 'storeId');
      const productId = uuidParam(req.params, 'productId');
      const p = guard(req, 'archiveProduct', storeId);
      await archiveProduct(storeClient(p, storeId), storeId, productId, p.actor);
      res.status(204).end();
    }),
  );
  r.post(
    '/admin/stores/:storeId/products/:productId/publish',
    handle(async (req, res) => {
      const storeId = uuidParam(req.params, 'storeId');
      const productId = uuidParam(req.params, 'productId');
      const p = guard(req, 'publishProduct', storeId);
      res.json(await publishProduct(storeClient(p, storeId), storeId, productId, p.actor));
    }),
  );

  // ---- catalog: variants -----------------------------------------------------------------------------------
  r.post(
    '/admin/stores/:storeId/products/:productId/variants',
    handle(async (req, res) => {
      const storeId = uuidParam(req.params, 'storeId');
      const productId = uuidParam(req.params, 'productId');
      const p = guard(req, 'createVariant', storeId, req.body);
      res
        .status(201)
        .json(await createVariant(storeClient(p, storeId), storeId, productId, req.body, p.actor));
    }),
  );
  r.patch(
    '/admin/stores/:storeId/variants/:variantId',
    handle(async (req, res) => {
      const storeId = uuidParam(req.params, 'storeId');
      const variantId = uuidParam(req.params, 'variantId');
      const p = guard(req, 'updateVariant', storeId, req.body);
      res.json(await updateVariant(storeClient(p, storeId), storeId, variantId, req.body, p.actor));
    }),
  );

  return r;
}
