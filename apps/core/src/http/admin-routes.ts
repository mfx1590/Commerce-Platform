// Admin API routes window 1 owns in Phase 1 (packages/contracts/openapi/admin-api.yaml): /admin/me, registry
// (stores, domains, sales channels, api keys, warehouses, legal entities) and catalog (categories, products,
// variants). Every route: `permission(op)` (the operation's x-permission, read from the spec, via
// requirePermission) → `body(op)` (JSON body validated against the operation's requestBody schema) → handler:
// scoped client → module service → contract shape. Mounted by mountCoreMiddleware AHEAD of Medusa (same reasons
// as the Store API routes). Everything else on the Admin API stays on the Prism mock (:4011).
import { Router, type Request, type RequestHandler } from 'express';
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

const spec = () => loadSpec('admin-api.yaml');

/** `requirePermission` for an operation's `x-permission`; `{storeId}` in the object comes from the path. */
function permission(operationId: string): RequestHandler {
  const perm = spec().permission(operationId);
  return requirePermission(perm.relation, (req: Request) =>
    resolveObject(perm.object, { storeId: one(req.params.storeId) }),
  );
}

/** Validates the JSON body against the operation's `requestBody` schema (400 `validation_error`). */
function body(operationId: string): RequestHandler {
  return (req, _res, next) => {
    try {
      spec().validateBody(operationId, req.body);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Store-scoped client for an admin request; `storeId` comes from the path (validated as a uuid). */
function storeClient(req: Request): { p: StaffPrincipal; storeId: string; client: ScopedClient } {
  const p = requirePrincipal(req);
  const storeId = uuidParam(req.params, 'storeId');
  return { p, storeId, client: storeClientFor(p, storeId) };
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
      const out: Principal = {
        user: p.user,
        organization,
        organization_relations: p.organizationRelations,
        stores: p.stores,
      };
      res.json(out);
    }),
  );

  // ---- registry: stores ------------------------------------------------------------------------------------
  r.get(
    '/admin/stores',
    permission('listStores'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const problems: Record<string, string> = {};
      const page = pageParams(req.query, 20, problems);
      throwIfProblems(problems);
      res.json(await listStores(visibleStoresClientFor(p), page));
    }),
  );
  r.post(
    '/admin/stores',
    permission('createStore'),
    body('createStore'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      res.status(201).json(await createStore(organizationClientFor(p), req.body, p.actor));
    }),
  );
  r.get(
    '/admin/stores/:storeId',
    permission('getStore'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      res.json(await getStore(client, storeId));
    }),
  );
  r.patch(
    '/admin/stores/:storeId',
    permission('updateStore'),
    body('updateStore'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      res.json(await updateStore(client, storeId, req.body, p.actor));
    }),
  );

  // ---- registry: domains, sales channels, api keys ---------------------------------------------------------
  r.get(
    '/admin/stores/:storeId/domains',
    permission('listDomains'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      res.json({ items: await listDomains(client, storeId) });
    }),
  );
  r.post(
    '/admin/stores/:storeId/domains',
    permission('addDomain'),
    body('addDomain'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      res.status(201).json(await addDomain(client, storeId, req.body, p.actor));
    }),
  );
  r.get(
    '/admin/stores/:storeId/sales-channels',
    permission('listSalesChannels'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      res.json({ items: await listSalesChannels(client, storeId) });
    }),
  );
  r.post(
    '/admin/stores/:storeId/sales-channels',
    permission('createSalesChannel'),
    body('createSalesChannel'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      res.status(201).json(await createSalesChannel(client, storeId, req.body, p.actor));
    }),
  );
  r.get(
    '/admin/stores/:storeId/api-keys',
    permission('listApiKeys'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      res.json({ items: await listApiKeys(client, storeId) });
    }),
  );
  r.post(
    '/admin/stores/:storeId/api-keys',
    permission('createApiKey'),
    body('createApiKey'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      res.status(201).json(await createApiKey(client, storeId, req.body, p.actor));
    }),
  );

  // ---- registry: organization level ------------------------------------------------------------------------
  r.get(
    '/admin/warehouses',
    permission('listWarehouses'),
    handle(async (req, res) => {
      res.json({ items: await listWarehouses(organizationClientFor(requirePrincipal(req))) });
    }),
  );
  r.get(
    '/admin/legal-entities',
    permission('listLegalEntities'),
    handle(async (req, res) => {
      res.json({ items: await listLegalEntities(organizationClientFor(requirePrincipal(req))) });
    }),
  );

  // ---- catalog: categories ---------------------------------------------------------------------------------
  r.get(
    '/admin/stores/:storeId/categories',
    permission('listCategories'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      res.json({ items: await listCategories(client, storeId) });
    }),
  );
  r.post(
    '/admin/stores/:storeId/categories',
    permission('createCategory'),
    body('createCategory'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      res.status(201).json(await createCategory(client, storeId, req.body, p.actor));
    }),
  );

  // ---- catalog: products -----------------------------------------------------------------------------------
  r.get(
    '/admin/stores/:storeId/products',
    permission('listProducts'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      const problems: Record<string, string> = {};
      const page = pageParams(req.query, 20, problems);
      const status = one(req.query.status);
      if (status !== undefined && !PRODUCT_STATUSES.includes(status as ProductStatus)) {
        problems.status = `one of ${PRODUCT_STATUSES.join(', ')}`;
      }
      const categoryId = one(req.query.category_id);
      if (categoryId !== undefined && !/^[0-9a-f-]{36}$/i.test(categoryId)) {
        problems.category_id = 'uuid';
      }
      throwIfProblems(problems);
      res.json(
        await listProducts(client, storeId, {
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
    permission('createProduct'),
    body('createProduct'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      res.status(201).json(await createProduct(client, storeId, req.body, p.actor));
    }),
  );
  r.get(
    '/admin/stores/:storeId/products/:productId',
    permission('getProduct'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      res.json(await getProduct(client, storeId, uuidParam(req.params, 'productId')));
    }),
  );
  r.patch(
    '/admin/stores/:storeId/products/:productId',
    permission('updateProduct'),
    body('updateProduct'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      res.json(
        await updateProduct(client, storeId, uuidParam(req.params, 'productId'), req.body, p.actor),
      );
    }),
  );
  r.delete(
    '/admin/stores/:storeId/products/:productId',
    permission('archiveProduct'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      await archiveProduct(client, storeId, uuidParam(req.params, 'productId'), p.actor);
      res.status(204).end();
    }),
  );
  r.post(
    '/admin/stores/:storeId/products/:productId/publish',
    permission('publishProduct'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      res.json(await publishProduct(client, storeId, uuidParam(req.params, 'productId'), p.actor));
    }),
  );

  // ---- catalog: variants -----------------------------------------------------------------------------------
  r.post(
    '/admin/stores/:storeId/products/:productId/variants',
    permission('createVariant'),
    body('createVariant'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      res
        .status(201)
        .json(
          await createVariant(
            client,
            storeId,
            uuidParam(req.params, 'productId'),
            req.body,
            p.actor,
          ),
        );
    }),
  );
  r.patch(
    '/admin/stores/:storeId/variants/:variantId',
    permission('updateVariant'),
    body('updateVariant'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      res.json(
        await updateVariant(client, storeId, uuidParam(req.params, 'variantId'), req.body, p.actor),
      );
    }),
  );

  return r;
}
