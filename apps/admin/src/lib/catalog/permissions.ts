/**
 * Catalog mutations the guard checks before the API (#870 wave 1 item 2): the `x-permission` of
 * each operation in `admin-api.yaml`, pinned in a unit test. Before this, publishing and archiving
 * (single row) relied on the Admin API's own check alone.
 */

import type { PermissionRule } from '../permissions/rules';

export const CATALOG_PERMISSIONS = {
  publishProduct: { relation: 'store_staff', object: 'store' },
  archiveProduct: { relation: 'store_admin', object: 'store' },
} as const satisfies Record<string, PermissionRule>;
