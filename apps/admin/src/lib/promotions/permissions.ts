/**
 * Promotion mutations the guard checks before the API (#903): the `x-permission` of each operation
 * in `admin-api.yaml`, pinned in a unit test.
 */

import type { PermissionRule } from '../permissions/rules';

export const PROMOTION_PERMISSIONS = {
  createPromotion: { relation: 'store_admin', object: 'store' },
  updatePromotion: { relation: 'store_admin', object: 'store' },
} as const satisfies Record<string, PermissionRule>;
