/**
 * HQ roles (#428): the mutations and the `x-permission` each carries in `admin-api.yaml` (Admin API
 * 0.4.12) — all `owner` on `organization:hq`. Read by the guard (`../permissions/guard.ts`, refusal
 * before the API) and by the page (what to offer); pinned against the yaml in a unit test.
 */

import type { PermissionRule } from '../permissions/rules';

export const ROLES_PERMISSIONS = {
  inviteUser: { relation: 'owner', object: 'organization' },
  assignRole: { relation: 'owner', object: 'organization' },
  revokeRole: { relation: 'owner', object: 'organization' },
} as const satisfies Record<string, PermissionRule>;

export type RolesOperation = keyof typeof ROLES_PERMISSIONS;
