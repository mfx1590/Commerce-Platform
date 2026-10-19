'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { assignRole, inviteUser, revokeRole } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { toActionResult, type ActionResult } from '@/lib/forms/action-result';
import { refuseUnlessPermitted } from '@/lib/permissions/guard';
import {
  inviteSchema,
  roleAssignmentSchema,
  type InviteValues,
  type RoleAssignmentValues,
} from '@/lib/roles';

/**
 * HQ roles (#428). Each action refuses server-side, before the API, unless the principal is
 * `owner` on `organization:hq` (`refuseUnlessPermitted`, `ROLES_PERMISSIONS`); path ids must be
 * uuids; bodies are re-validated with the form's schema. Assigning and revoking end the user's
 * sessions in the core, which is why the page asks before revoking.
 */

type StaffUser = AdminComponents['StaffUser'];
type RoleAssignment = AdminComponents['RoleAssignment'];

const UUID = z.string().uuid();

function invalid(message = 'Some fields are not valid.'): ActionResult<never> {
  return { status: 'error', fieldErrors: {}, formError: message };
}

export interface InviteOutcome {
  user: StaffUser;
  /** The initial relation, when one was asked for and granted. */
  assignment: RoleAssignment | null;
  /** The user exists but the initial relation was refused; said, not hidden. */
  assignmentError: string | null;
}

/**
 * `inviteUser`, then — the contract takes no initial role — `assignRole` for the optional first
 * relation. A taken email (409) is put under the email field.
 */
export async function inviteUserAction(values: InviteValues): Promise<ActionResult<InviteOutcome>> {
  const refused = await refuseUnlessPermitted('inviteUser', '');
  if (refused !== null) return refused;
  const parsed = inviteSchema.safeParse(values);
  if (!parsed.success) return invalid();

  const { initial, ...person } = parsed.data;
  const invited = await inviteUser(person);
  if (!invited.ok) {
    if (invited.status === 409) {
      return {
        status: 'error',
        fieldErrors: { email: 'A staff user with this email already exists.' },
        formError: null,
      };
    }
    return toActionResult(invited, ['email', 'display_name']);
  }

  let assignment: RoleAssignment | null = null;
  let assignmentError: string | null = null;
  if (initial !== undefined) {
    const granted = await assignRole(invited.data.id, initial);
    if (granted.ok) assignment = granted.data;
    else
      assignmentError = `Invited, but the initial relation was not granted: ${granted.error.message}`;
  }
  revalidatePath('/roles');
  return { status: 'success', data: { user: invited.data, assignment, assignmentError } };
}

export async function assignRoleAction(
  userId: string,
  values: RoleAssignmentValues,
): Promise<ActionResult<RoleAssignment>> {
  const refused = await refuseUnlessPermitted('assignRole', '');
  if (refused !== null) return refused;
  if (!UUID.safeParse(userId).success) return invalid('That user is not valid.');
  const parsed = roleAssignmentSchema.safeParse(values);
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message);
  const result = await assignRole(userId, parsed.data);
  if (result.ok) revalidatePath('/roles');
  return toActionResult(result, ['relation', 'object_type', 'object_id']);
}

export async function revokeRoleAction(
  userId: string,
  assignmentId: string,
): Promise<ActionResult<null>> {
  const refused = await refuseUnlessPermitted('revokeRole', '');
  if (refused !== null) return refused;
  if (!UUID.safeParse(userId).success || !UUID.safeParse(assignmentId).success) {
    return invalid('That assignment is not valid.');
  }
  const result = await revokeRole(userId, assignmentId);
  if (result.ok) {
    revalidatePath('/roles');
    return { status: 'success', data: null };
  }
  return toActionResult(result, []);
}
