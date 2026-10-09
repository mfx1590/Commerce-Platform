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
  PRODUCT_SORT_FIELDS,
  type ProductStatus,
} from '../modules/catalog';
import {
  activateStore,
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
  onboardStore,
  revokeApiKey,
  updateDomain,
  updateStore,
  type StoreRegistrar,
  STORE_SORT_FIELDS,
} from '../modules/registry';
import { organizationClient, tenantClient } from '../lib/db';
import { AppError, validationError } from '../lib/errors';
import { handle } from './errors';
import {
  ADMIN_MOVEMENT_REASONS,
  createStockMovement,
  LEVEL_SORT_FIELDS,
  listInventoryLevels,
} from '../modules/inventory';
import { getReturn, receiveReturn, requestReturn } from '../modules/returns';
import {
  cancelOrder,
  FULFILLMENT_STATUSES,
  getAdminOrder,
  listAdminOrders,
  ORDER_SORT_FIELDS,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
} from '../modules/orders';
import {
  adminGetCustomer,
  adminListCustomerAddresses,
  adminListCustomers,
  adminUpdateCustomer,
  CUSTOMER_SORT_FIELDS,
  eraseCustomer,
  listCustomerGroups,
  requestCustomerExport,
} from '../modules/customers';
import { loadSpec } from './openapi';
import { requirePermission, resolveObject } from './permissions';
import {
  dateParam,
  enumParam,
  intParam,
  one,
  pageParams,
  sortParams,
  throwIfProblems,
  uuidParam,
} from './query';
import {
  hasOrganizationAccess,
  organizationClientFor,
  requirePrincipal,
  storeClientFor,
  type StaffPrincipal,
  visibleStoresClientFor,
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Onboarding without a registrar would create stores nobody can see: refused as a 503, never guessed. */
function requireRegistrar(registrar: StoreRegistrar | undefined): StoreRegistrar {
  if (!registrar) throw new AppError('internal', 'store registrar not configured', {}, 503);
  return registrar;
}

export interface AdminRouterOptions {
  /**
   * The OpenFGA side of store onboarding (#413): `ensureStoreObject` after the onboarding transaction and the
   * `fga_object` activation prerequisite. mountCoreMiddleware() passes the OpenFGA adapter (src/http/store-registrar.ts)
   * unless a test hands in the in-memory one from the registry module.
   */
  storeRegistrar?: StoreRegistrar;
}

export function adminRouter(opts: AdminRouterOptions = {}): Router {
  const r = Router();
  const registrar = opts.storeRegistrar;

  // ---- inventory (task 2.4, src/modules/inventory) ----------------------------------------------------------
  // listInventoryLevels' x-permission is `viewer` on `store:{store_id}` with store_id an OPTIONAL query: with it
  // the check is that store; without it the check is `store:*` (any visible store) and the list is limited to
  // the principal's visible stores by the client's RLS scope.
  r.get(
    '/admin/inventory/levels',
    requirePermission(spec().permission('listInventoryLevels').relation, (req) => {
      const storeId = one(req.query.store_id);
      // a malformed store_id is a 400 (input shape), decided before the permission check would say 403
      if (storeId !== undefined && !UUID_RE.test(storeId)) {
        throw validationError('invalid query', { store_id: 'uuid' });
      }
      return storeId ? `store:${storeId}` : 'store:*';
    }),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const problems: Record<string, string> = {};
      const page = pageParams(req.query, 20, problems);
      const sort = sortParams(req.query, LEVEL_SORT_FIELDS, problems);
      const storeId = one(req.query.store_id);
      const warehouseId = one(req.query.warehouse_id);
      const variantId = one(req.query.variant_id);
      for (const [name, value] of [
        ['store_id', storeId],
        ['warehouse_id', warehouseId],
        ['variant_id', variantId],
      ] as const) {
        if (value !== undefined && !UUID_RE.test(value)) problems[name] = 'uuid';
      }
      const below = intParam(req.query, 'below_available', { min: -1_000_000 }, problems);
      throwIfProblems(problems);
      const client =
        storeId && !hasOrganizationAccess(p)
          ? storeClientFor(p, storeId)
          : storeId
            ? tenantClient({ organizationId: p.organizationId, storeIds: [storeId] })
            : visibleStoresClientFor(p);
      res.json(
        await listInventoryLevels(client, {
          ...page,
          ...sort,
          store_id: storeId,
          warehouse_id: warehouseId,
          variant_id: variantId,
          sku: one(req.query.sku),
          below_available: below,
        }),
      );
    }),
  );
  r.post(
    '/admin/inventory/movements',
    permission('createStockMovement'),
    body('createStockMovement'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const b = req.body as {
        variant_id: string;
        warehouse_id: string;
        delta: number;
        reason: (typeof ADMIN_MOVEMENT_REASONS)[number];
        note?: string;
      };
      if (!(ADMIN_MOVEMENT_REASONS as readonly string[]).includes(b.reason)) {
        throw validationError('invalid reason', {
          reason: `one of ${ADMIN_MOVEMENT_REASONS.join(', ')}`,
        });
      }
      res.status(201).json(
        await createStockMovement(organizationClientFor(p), {
          organizationId: p.organizationId,
          variantId: b.variant_id,
          warehouseId: b.warehouse_id,
          delta: b.delta,
          reason: b.reason,
          note: b.note ?? null,
          actor: p.actor,
        }),
      );
    }),
  );

  // ---- returns (task 2.5, src/modules/returns) --------------------------------------------------------------
  r.post(
    '/admin/stores/:storeId/orders/:orderId/returns',
    permission('createReturn'),
    body('createReturn'),
    handle(async (req, res) => {
      const { client } = storeClient(req);
      const p = requirePrincipal(req);
      const b = req.body as {
        items: { order_line_item_id: string; quantity: number }[];
        reason?: string;
      };
      res.status(201).json(
        await requestReturn(client, uuidParam(req.params, 'orderId'), {
          items: b.items,
          reason: b.reason ?? null,
          actor: p.actor,
        }),
      );
    }),
  );
  // receiveReturn: x-permission is `operations` on the organization; the store id in the path must be the
  // return's store (404 otherwise — a return is never confirmable through another store's path).
  r.post(
    '/admin/stores/:storeId/returns/:returnId/receive',
    permission('receiveReturn'),
    body('receiveReturn'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const storeId = uuidParam(req.params, 'storeId');
      const returnId = uuidParam(req.params, 'returnId');
      const client = tenantClient({ organizationId: p.organizationId, storeIds: [storeId] });
      await getReturn(client, returnId); // 404 unless the return belongs to this store
      const b = req.body as {
        warehouse_id: string;
        items: {
          order_line_item_id: string;
          quantity: number;
          condition: 'resellable' | 'damaged';
        }[];
      };
      res.json(
        await receiveReturn(client, returnId, {
          warehouseId: b.warehouse_id,
          items: b.items,
          actor: p.actor,
        }),
      );
    }),
  );

  // ---- orders (task 2.3, src/modules/orders) ----------------------------------------------------------------
  r.get(
    '/admin/stores/:storeId/orders',
    permission('listOrders'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      const problems: Record<string, string> = {};
      const page = pageParams(req.query, 20, problems);
      const sort = sortParams(req.query, ORDER_SORT_FIELDS, problems);
      const status = enumParam(req.query, 'status', ORDER_STATUSES, problems);
      const paymentStatus = enumParam(req.query, 'payment_status', PAYMENT_STATUSES, problems);
      const fulfillmentStatus = enumParam(
        req.query,
        'fulfillment_status',
        FULFILLMENT_STATUSES,
        problems,
      );
      const placedFrom = dateParam(req.query, 'placed_from', problems);
      const placedTo = dateParam(req.query, 'placed_to', problems);
      throwIfProblems(problems);
      res.json(
        await listAdminOrders(client, storeId, {
          ...page,
          ...sort,
          status,
          payment_status: paymentStatus,
          fulfillment_status: fulfillmentStatus,
          q: one(req.query.q),
          placed_from: placedFrom,
          placed_to: placedTo,
        }),
      );
    }),
  );
  r.get(
    '/admin/stores/:storeId/orders/:orderId',
    permission('getOrder'),
    handle(async (req, res) => {
      const { client } = storeClient(req);
      res.json(await getAdminOrder(client, uuidParam(req.params, 'orderId')));
    }),
  );
  r.post(
    '/admin/stores/:storeId/orders/:orderId/cancel',
    permission('cancelOrder'),
    body('cancelOrder'),
    handle(async (req, res) => {
      const { client } = storeClient(req);
      const p = requirePrincipal(req);
      res.json(
        await cancelOrder(client, uuidParam(req.params, 'orderId'), {
          reason: String((req.body as { reason: string }).reason),
          actor: p.actor,
        }),
      );
    }),
  );

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
      const sort = sortParams(req.query, STORE_SORT_FIELDS, problems);
      throwIfProblems(problems);
      res.json(await listStores(visibleStoresClientFor(p), { ...page, ...sort }));
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
      res.json(
        await updateStore(client, storeId, req.body, p.actor, registrar ? { registrar } : {}),
      );
    }),
  );
  // ---- customers (#414, Admin API 0.4.11): support reads and updates, store_admin erases and exports -------
  r.get(
    '/admin/stores/:storeId/customers',
    permission('listCustomers'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      const problems: Record<string, string> = {};
      const page = pageParams(req.query, 20, problems);
      const sort = sortParams(req.query, CUSTOMER_SORT_FIELDS, problems);
      const groupId = one(req.query.group_id);
      if (groupId !== undefined && !UUID_RE.test(groupId)) problems.group_id = 'uuid';
      throwIfProblems(problems);
      res.json(
        await adminListCustomers(client, storeId, {
          ...page,
          ...sort,
          ...(one(req.query.q) !== undefined ? { q: one(req.query.q)! } : {}),
          ...(groupId !== undefined ? { group_id: groupId } : {}),
        }),
      );
    }),
  );
  r.get(
    '/admin/stores/:storeId/customers/:customerId',
    permission('getCustomer'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      res.json(await adminGetCustomer(client, storeId, uuidParam(req.params, 'customerId')));
    }),
  );
  r.patch(
    '/admin/stores/:storeId/customers/:customerId',
    permission('updateCustomer'),
    body('updateCustomer'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      res.json(
        await adminUpdateCustomer(
          client,
          storeId,
          uuidParam(req.params, 'customerId'),
          req.body,
          p.actor,
        ),
      );
    }),
  );
  r.get(
    '/admin/stores/:storeId/customers/:customerId/addresses',
    permission('listCustomerAddresses'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      res.json({
        items: await adminListCustomerAddresses(
          client,
          storeId,
          uuidParam(req.params, 'customerId'),
        ),
      });
    }),
  );
  // GDPR erasure: 202 both for the erasure and for the replay on an erased customer (the contract's
  // "scheduled"; it runs synchronously, one transaction) — no body.
  r.post(
    '/admin/stores/:storeId/customers/:customerId/erase',
    permission('eraseCustomer'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      await eraseCustomer(client, storeId, uuidParam(req.params, 'customerId'), p.actor);
      res.status(202).end();
    }),
  );
  // GDPR export: 202 + one `customer.export_requested` per request; the bundle is built by the delivery job.
  r.post(
    '/admin/stores/:storeId/customers/:customerId/export',
    permission('exportCustomer'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      await requestCustomerExport(client, storeId, uuidParam(req.params, 'customerId'), p.actor);
      res.status(202).end();
    }),
  );
  r.get(
    '/admin/stores/:storeId/customer-groups',
    permission('listCustomerGroups'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      res.json({ items: await listCustomerGroups(client, storeId) });
    }),
  );

  // ---- registry: onboarding (#413, Admin API 0.4.11) ------------------------------------------------------
  r.post(
    '/admin/stores/:storeId/activate',
    permission('activateStore'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const storeId = uuidParam(req.params, 'storeId');
      res.json(
        await activateStore(
          organizationClientFor(p),
          storeId,
          requireRegistrar(registrar),
          p.actor,
        ),
      );
    }),
  );
  r.post(
    '/admin/onboarding/stores',
    permission('onboardStore'),
    body('onboardStore'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const { created, result } = await onboardStore(
        organizationClientFor(p),
        req.body,
        requireRegistrar(registrar),
        p.actor,
      );
      res.status(created ? 201 : 200).json(result);
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
  r.patch(
    '/admin/stores/:storeId/domains/:domainId',
    permission('updateDomain'),
    body('updateDomain'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      const domainId = uuidParam(req.params, 'domainId');
      res.json(await updateDomain(client, storeId, domainId, req.body, p.actor));
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
  r.post(
    '/admin/stores/:storeId/api-keys/:keyId/revoke',
    permission('revokeApiKey'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      const keyId = uuidParam(req.params, 'keyId');
      res.json(await revokeApiKey(client, storeId, keyId, p.actor));
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
      const sort = sortParams(req.query, PRODUCT_SORT_FIELDS, problems);
      throwIfProblems(problems);
      res.json(
        await listProducts(client, storeId, {
          ...page,
          ...sort,
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
