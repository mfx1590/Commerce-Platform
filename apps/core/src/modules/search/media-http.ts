// Admin API media routes (task 2.3, #136) as a mountable Express router — same arrangement as the merchandising
// router: the operations are the proposed proposed/admin-api.media.yaml (CONTRACT CHANGE), relations hard-coded
// from it (`viewer` list, `store_staff` write, like the product operations) and bodies validated by
// media-types.ts until `loadSpec('admin-api.yaml')` can take over. Window 1 mounts it next to `adminRouter()`.
import { Router, type Request } from 'express';
import type { ScopedClient } from '@platform/db';
import { AppError } from '../../lib/errors';
import { handle } from '../../http/errors';
import { requirePermission } from '../../http/permissions';
import { uuidParam } from '../../http/query';
import { requirePrincipal, storeClientFor, type StaffPrincipal } from '../../http/staff-auth';
import { cloudinaryCredentialsFor, type CloudinaryCredentials } from './cloudinary';
import {
  addProductMedia,
  createUploadParams,
  deleteProductMedia,
  listProductMedia,
  updateProductMedia,
} from './media';

export interface MediaRouterOptions {
  /** Override for tests; default reads the environment per store code. */
  credentialsFor?: (storeCode: string) => CloudinaryCredentials | null;
  now?: () => Date;
}

export const MEDIA_UPLOAD_PATH = '/admin/stores/:storeId/media/upload-params';
export const PRODUCT_MEDIA_BASE = '/admin/stores/:storeId/products/:productId/media';

function storeClient(req: Request): { p: StaffPrincipal; storeId: string; client: ScopedClient } {
  const p = requirePrincipal(req);
  const storeId = uuidParam(req.params, 'storeId');
  return { p, storeId, client: storeClientFor(p, storeId) };
}

const permission = (relation: 'viewer' | 'store_staff') =>
  requirePermission(relation, (req) => `store:${uuidParam(req.params, 'storeId')}`);

export function mediaRouter(opts: MediaRouterOptions = {}): Router {
  const r = Router();
  const credentialsFor = opts.credentialsFor ?? cloudinaryCredentialsFor;

  r.post(
    MEDIA_UPLOAD_PATH,
    permission('store_staff'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      const store = await client.query<{ id: string; code: string }>(
        'SELECT id, code FROM store WHERE id = $1',
        [storeId],
      );
      const row = store.rows[0];
      if (!row) throw new AppError('not_found', `store ${storeId} not found`);
      const params = await createUploadParams(
        client,
        row,
        req.body,
        credentialsFor(row.code),
        opts.now ? { now: opts.now() } : {},
      );
      if (!params)
        throw new AppError('conflict', 'store has no media upload credentials configured', {
          store_code: row.code,
        });
      res.json(params);
    }),
  );
  r.get(
    PRODUCT_MEDIA_BASE,
    permission('viewer'),
    handle(async (req, res) => {
      const { client, storeId } = storeClient(req);
      res.json({
        items: await listProductMedia(client, storeId, uuidParam(req.params, 'productId')),
      });
    }),
  );
  r.post(
    PRODUCT_MEDIA_BASE,
    permission('store_staff'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      res
        .status(201)
        .json(
          await addProductMedia(
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
    `${PRODUCT_MEDIA_BASE}/:mediaId`,
    permission('store_staff'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      res.json(
        await updateProductMedia(
          client,
          storeId,
          uuidParam(req.params, 'productId'),
          uuidParam(req.params, 'mediaId'),
          req.body,
          p.actor,
        ),
      );
    }),
  );
  r.delete(
    `${PRODUCT_MEDIA_BASE}/:mediaId`,
    permission('store_staff'),
    handle(async (req, res) => {
      const { p, client, storeId } = storeClient(req);
      await deleteProductMedia(
        client,
        storeId,
        uuidParam(req.params, 'productId'),
        uuidParam(req.params, 'mediaId'),
        p.actor,
      );
      res.status(204).end();
    }),
  );
  return r;
}
