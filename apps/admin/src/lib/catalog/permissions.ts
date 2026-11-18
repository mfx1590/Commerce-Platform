/**
 * Catalog mutations the guard checks before the API (#870 wave 1 item 2): the `x-permission` of
 * each operation in `admin-api.yaml`, pinned in a unit test. Before this (#870 audit), NO catalog
 * action checked server-side in the admin: every one relied on the Admin API's own check alone.
 */

import type { PermissionRule } from '../permissions/rules';

export const CATALOG_PERMISSIONS = {
  createProduct: { relation: 'store_staff', object: 'store' },
  updateProduct: { relation: 'store_staff', object: 'store' },
  createVariant: { relation: 'store_staff', object: 'store' },
  updateVariant: { relation: 'store_staff', object: 'store' },
  createCategory: { relation: 'store_staff', object: 'store' },
  publishProduct: { relation: 'store_staff', object: 'store' },
  archiveProduct: { relation: 'store_admin', object: 'store' },
} as const satisfies Record<string, PermissionRule>;
