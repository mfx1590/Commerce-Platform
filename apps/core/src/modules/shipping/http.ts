// Shipping's HTTP surface as two mountable Express routers (task 2.3, #131). Mount points (REQUEST #176,
// window 1):
//
//   app.use(shippingWebhookRouter())   in mountCoreMiddleware, before coreErrorHandler and OUTSIDE the /store and
//                                      /admin chains — a carrier is neither a customer nor staff; the signature
//                                      over the raw body is the authentication. Same place as paymentsWebhookRouter.
//   routers.push(shippingAdminRouter())  in src/http/module-routers.ts, after adminRouter(): the same staff
//                                      principal, JSON body parser and error handler as every admin route.
//
// Admin permissions are each operation's `x-permission` from admin-api.yaml, read through `loadSpec` (never
// hard-coded), and request bodies are validated against the spec's `requestBody`.
import express, { Router, type RequestHandler } from 'express';
import { handle } from '../../http/errors';
import { loadSpec } from '../../http/openapi';
import { requirePermission, resolveObject } from '../../http/permissions';
import { uuidParam } from '../../http/query';
import { coreOrganizationId } from '../../http/tenant';
import {
  organizationClientFor,
  requirePrincipal,
  storeClientFor,
  type StaffPrincipal,
} from '../../http/staff-auth';
import { organizationClient, tenantClient } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { easyPostWebhookSecretFor } from './config';
import {
  createShipment,
  updateShipment,
  type ShipmentItem,
  type ShipmentStatus,
} from './shipments';
import { handleEasyPostWebhook } from './tracking';

export const EASYPOST_WEBHOOK_PATH = '/webhooks/easypost/:storeCode';
/** Tracker updates are a few KB even with a long scan history; anything larger is not one. */
export const EASYPOST_WEBHOOK_BODY_LIMIT = '512kb';
export const CREATE_SHIPMENT_PATH = '/admin/stores/:storeId/orders/:orderId/shipments';
export const UPDATE_SHIPMENT_PATH = '/admin/shipments/:shipmentId';

export interface ShippingWebhookRouterOptions {
  env?: NodeJS.ProcessEnv;
  /** One line per delivery (ids and outcome only); default console.info. Tests pass a spy. */
  log?: (line: string) => void;
}

/**
 * `POST /webhooks/easypost/:storeCode`. One EasyPost webhook per store, signed with that store's secret. The store
 * is resolved before anything is stored (#187: an unresolvable delivery is never stored), the secret before the
 * body is read, and the body is kept as raw bytes for the HMAC whatever content type the carrier declares.
 */
export function shippingWebhookRouter(opts: ShippingWebhookRouterOptions = {}): Router {
  const router = Router();
  const log = opts.log ?? ((line: string) => console.info(line));
  router.post(
    EASYPOST_WEBHOOK_PATH,
    express.raw({ type: () => true, limit: EASYPOST_WEBHOOK_BODY_LIMIT }),
    handle(async (req, res) => {
      const storeCode = String(req.params.storeCode ?? '');
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(storeCode)) {
        throw new AppError('not_found', 'store not found');
      }
      const organizationId = coreOrganizationId();
      const store = await organizationClient({ organizationId }).query<{ id: string }>(
        `SELECT id FROM store WHERE code = $1`,
        [storeCode],
      );
      const storeId = store.rows[0]?.id;
      if (!storeId) throw new AppError('not_found', `store ${storeCode} not found`);

      const secret = easyPostWebhookSecretFor(storeCode, opts.env);
      if (!secret) {
        // The variable NAME is safe to report; the value never is.
        throw new AppError(
          'internal',
          'tracking webhooks are not configured for this store',
          {
            missing: `EASYPOST_WEBHOOK_SECRET_${storeCode.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
          },
          503,
        );
      }

      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const result = await handleEasyPostWebhook(
        tenantClient({ organizationId, storeIds: [storeId] }),
        {
          rawBody,
          signature: req.header('x-hmac-signature'),
          secret: secret.secret,
          organizationId,
          storeId,
        },
      );
      log(
        `shipping webhook easypost store=${storeCode} event=${result.eventId} outcome=${result.outcome}` +
          (result.shipmentId ? ` shipment=${result.shipmentId}` : ''),
      );
      // EasyPost only needs a 2xx; the body is for whoever reads the delivery log.
      res.status(200).json({
        received: true,
        event_id: result.eventId,
        outcome: result.outcome,
        shipment_id: result.shipmentId,
        ...(result.reason ? { reason: result.reason } : {}),
      });
    }),
  );
  return router;
}

/** `requirePermission` for the operation's `x-permission`; `{storeId}` in the object comes from the path. */
function permission(operationId: string): RequestHandler {
  const perm = loadSpec('admin-api.yaml').permission(operationId);
  return requirePermission(perm.relation, (req) =>
    resolveObject(perm.object, {
      storeId: typeof req.params.storeId === 'string' ? req.params.storeId : undefined,
    }),
  );
}

/** Validates the JSON body against the operation's `requestBody` schema (400 `validation_error`). */
function body(operationId: string): RequestHandler {
  return (req, _res, next) => {
    try {
      loadSpec('admin-api.yaml').validateBody(operationId, req.body);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Admin API `createShipment` and `updateShipment`. Both carry `x-permission: operations` on the organization. The
 * store-scoped client still applies: `createShipment` takes the store from its path, and `updateShipment` — whose
 * path has no store — resolves the shipment's store and then asks for a client scoped to it, so RLS and the
 * principal's store scope both still hold.
 */
export function shippingAdminRouter(): Router {
  const r = Router();

  r.post(
    CREATE_SHIPMENT_PATH,
    permission('createShipment'),
    body('createShipment'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const client = storeClientFor(p, uuidParam(req.params, 'storeId'));
      const b = req.body as {
        warehouse_id: string;
        carrier?: string;
        service?: string;
        items: ShipmentItem[];
      };
      res.status(201).json(
        await createShipment(client, {
          orderId: uuidParam(req.params, 'orderId'),
          warehouseId: b.warehouse_id,
          carrier: b.carrier,
          service: b.service,
          items: b.items,
          actor: p.actor,
        }),
      );
    }),
  );

  r.patch(
    UPDATE_SHIPMENT_PATH,
    permission('updateShipment'),
    body('updateShipment'),
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      const shipmentId = uuidParam(req.params, 'shipmentId');
      const client = storeClientFor(p, await storeOfShipment(p, shipmentId));
      const b = req.body as {
        status?: ShipmentStatus;
        tracking_number?: string;
        tracking_url?: string;
        label_url?: string;
        cost_minor?: number;
      };
      res.json(
        await updateShipment(client, shipmentId, {
          status: b.status,
          trackingNumber: b.tracking_number,
          trackingUrl: b.tracking_url,
          labelUrl: b.label_url,
          costMinor: b.cost_minor,
          actor: p.actor,
        }),
      );
    }),
  );

  return r;
}

/** The store a shipment belongs to, for an operation whose path names none. Unknown → 404. */
async function storeOfShipment(p: StaffPrincipal, shipmentId: string): Promise<string> {
  const r = await organizationClientFor(p).query<{ store_id: string }>(
    `SELECT store_id FROM shipment WHERE id = $1`,
    [shipmentId],
  );
  const storeId = r.rows[0]?.store_id;
  if (!storeId) throw new AppError('not_found', `shipment ${shipmentId} not found`);
  return storeId;
}
