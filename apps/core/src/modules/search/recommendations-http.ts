// Store API recommendation route (task P5.8, #607) as a mountable Express router.
//
// Store-side, so unlike this module's admin routers there is no `x-permission`: the publishable key resolved the
// store and `req.tenant` carries the store-scoped client, exactly as window 1's own Store API handlers do. The
// operation is `listProductRecommendations` (Store API 0.5.9).
//
// NOT MOUNTED YET: the Store API chain is window 1's (`src/http/store-routes.ts`); there is no store-side
// equivalent of `moduleAdminRouters()` yet, so the REQUEST asks window 1 for one (see the module README). Until
// then the router is exercised directly in recommendations-http.test.ts over a tenant-stub middleware.
import { Router } from 'express';
import { handle } from '../../http/errors';
import { enumParam, intParam, one, throwIfProblems } from '../../http/query';
import { requireTenant } from '../../http/tenant';
import { listProductRecommendations } from './recommendations';
import {
  POPULAR_WINDOWS,
  type PopularWindow,
  type RecommendationKind,
} from './recommendations-types';

export const RECOMMENDATIONS_PATH = '/store/recommendations';

const KINDS: readonly RecommendationKind[] = ['bought_together', 'popular'];
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 24;
const MAX_VARIANT_IDS = 100;
const CURRENCY = /^[A-Z]{3}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function recommendationsRouter(): Router {
  const r = Router();

  r.get(
    RECOMMENDATIONS_PATH,
    handle(async (req, res) => {
      const tenant = requireTenant(req);
      const problems: Record<string, string> = {};

      const kind = enumParam(req.query, 'kind', KINDS, problems) ?? 'bought_together';
      const limit =
        intParam(req.query, 'limit', { min: 1, max: MAX_LIMIT }, problems) ?? DEFAULT_LIMIT;

      const windowRaw = intParam(req.query, 'window_days', { min: 1 }, problems);
      let windowDays: PopularWindow = 30;
      if (windowRaw !== undefined) {
        if (!(POPULAR_WINDOWS as readonly number[]).includes(windowRaw)) {
          problems.window_days = `one of ${POPULAR_WINDOWS.join(', ')}`;
        } else {
          windowDays = windowRaw as PopularWindow;
        }
      }

      const productId = one(req.query.product_id);
      if (productId !== undefined && productId !== '' && !UUID.test(productId)) {
        problems.product_id = 'uuid';
      }

      const variantRaw = one(req.query.variant_ids);
      let variantIds: string[] | undefined;
      if (variantRaw !== undefined && variantRaw !== '') {
        // `style: form, explode: false` in the spec — one comma-separated value.
        variantIds = variantRaw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '');
        if (variantIds.length === 0) variantIds = undefined;
        else if (variantIds.length > MAX_VARIANT_IDS)
          problems.variant_ids = `at most ${MAX_VARIANT_IDS} ids`;
        else if (!variantIds.every((v) => UUID.test(v)))
          problems.variant_ids = 'comma-separated uuids';
      }

      const currency = one(req.query.currency);
      if (currency !== undefined && currency !== '' && !CURRENCY.test(currency)) {
        problems.currency = 'three uppercase letters';
      }

      // The contract's rule: `bought_together` needs exactly one anchor; `popular` is store-wide and ignores both.
      const hasProduct = productId !== undefined && productId !== '';
      const hasVariants = variantIds !== undefined;
      if (
        kind === 'bought_together' &&
        problems.product_id === undefined &&
        problems.variant_ids === undefined
      ) {
        if (hasProduct && hasVariants) {
          problems.product_id = 'give product_id or variant_ids, not both';
        } else if (!hasProduct && !hasVariants) {
          problems.product_id = 'product_id or variant_ids is required for kind=bought_together';
        }
      }
      throwIfProblems(problems);

      const result = await listProductRecommendations(
        { client: tenant.client, storeId: tenant.storeId, defaultCurrency: tenant.defaultCurrency },
        {
          kind,
          ...(kind === 'bought_together' && hasProduct ? { productId } : {}),
          ...(kind === 'bought_together' && hasVariants ? { variantIds } : {}),
          windowDays,
          limit,
          ...(currency ? { currency } : {}),
        },
      );
      res.json(result);
    }),
  );

  return r;
}
