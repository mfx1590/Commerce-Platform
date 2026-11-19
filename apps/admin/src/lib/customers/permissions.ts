/**
 * Customer mutations the guard checks before the API (#903): the `x-permission` of each operation
 * in `admin-api.yaml`, pinned in a unit test. Erasure is irreversible and privacy-critical, so it is
 * refused in the admin before the request is sent, not only by the Admin API.
 */

import type { PermissionRule } from '../permissions/rules';

export const CUSTOMER_PERMISSIONS = {
  updateCustomer: { relation: 'support', object: 'store' },
  eraseCustomer: { relation: 'store_admin', object: 'store' },
} as const satisfies Record<string, PermissionRule>;
