/**
 * Marketing mutations the guard checks before the API (#925): the `x-permission` of each operation
 * in `admin-api.yaml`, pinned in a unit test. `previewSegment` writes nothing but runs the rule set
 * against the store's customers, so it is gated too (store_staff, as the yaml says).
 */

import type { PermissionRule } from '../permissions/rules';

export const MARKETING_PERMISSIONS = {
  createCampaign: { relation: 'store_admin', object: 'store' },
  launchCampaign: { relation: 'store_admin', object: 'store' },
  endCampaign: { relation: 'store_admin', object: 'store' },
  createSegment: { relation: 'store_admin', object: 'store' },
  updateSegment: { relation: 'store_admin', object: 'store' },
  previewSegment: { relation: 'store_staff', object: 'store' },
  materializeSegment: { relation: 'store_admin', object: 'store' },
  createFeed: { relation: 'store_admin', object: 'store' },
  publishFeed: { relation: 'store_admin', object: 'store' },
} as const satisfies Record<string, PermissionRule>;
