/**
 * The list reads behind the POST-backed searches (#946): the `x-permission` of each operation in
 * `admin-api.yaml`, pinned in a unit test. A search is a read, but it runs as a server action (a public
 * POST endpoint), so it is refused before the API like every other action.
 */

import type { PermissionRule } from '../permissions/rules';

export const LIST_SEARCH_PERMISSIONS = {
  listCustomers: { relation: 'support', object: 'store' },
  listOrders: { relation: 'viewer', object: 'store' },
} as const satisfies Record<string, PermissionRule>;
