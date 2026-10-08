/**
 * HQ roles (#428): which relation may be granted on which object, and the form schemas.
 *
 * Grantable directly (`[user]` in `infra/openfga/model.fga`, mirrored in `../nav/relations.ts`):
 * on the organization `owner`, `finance`, `operations`, `analyst`, `support`; on a store
 * `store_admin`, `store_staff`, `support`. An analyst on a store only exists by implication from
 * the organization, and finance is organization-only — the form never offers a pair the model
 * would refuse, and the server action re-validates it.
 */

import { z } from 'zod';
import type { AdminComponents } from '../api/admin-client';

export { ROLES_PERMISSIONS, type RolesOperation } from './permissions';

type Relation = AdminComponents['Relation'];
export type ObjectType = 'organization' | 'store';

export const GRANTABLE: Record<ObjectType, readonly Relation[]> = {
  organization: ['owner', 'finance', 'operations', 'analyst', 'support'],
  store: ['store_admin', 'store_staff', 'support'],
};

export function grantable(objectType: ObjectType, relation: string): boolean {
  return (GRANTABLE[objectType] as readonly string[]).includes(relation);
}

const RELATION_VALUES = [
  'owner',
  'finance',
  'operations',
  'store_admin',
  'store_staff',
  'support',
  'analyst',
] as const satisfies readonly Relation[];

/** `assignRole`'s body: relation on an organization or a store, by id. */
export const roleAssignmentSchema = z
  .object({
    relation: z.enum(RELATION_VALUES),
    object_type: z.enum(['organization', 'store']),
    object_id: z.string().uuid('Choose a store or the organization'),
  })
  .strict()
  .refine((value) => grantable(value.object_type, value.relation), {
    message: 'That relation cannot be granted on that object',
    path: ['relation'],
  });
export type RoleAssignmentValues = z.infer<typeof roleAssignmentSchema>;

/** The invite form: the person, and optionally the first relation to grant after the 201. */
export const inviteSchema = z
  .object({
    email: z.string().min(1, 'Enter an email').email('Enter an email address'),
    display_name: z.string().trim().min(1, 'Enter a display name'),
    initial: roleAssignmentSchema.optional(),
  })
  .strict();
export type InviteValues = z.infer<typeof inviteSchema>;
