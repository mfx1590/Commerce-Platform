// inviteUser (issue #415, task 3.1b) — `POST /admin/users` as the contract documents it: the Keycloak staff
// user (email = username, required actions UPDATE_PASSWORD + CONFIGURE_TOTP, no password), the `staff_user`
// mirror row with `keycloak_subject`, an audit row, an optional initial role through `assignRole`. The
// invitation EMAIL is out of scope until SMTP exists (Integration 2b): in dev the Keycloak admin console or
// `execute-actions-email` sends it. Order: Keycloak user → (row + audit) in one transaction → if that fails
// the Keycloak user is deleted again, so a retry never meets a half-invited user.
import { audit, type AuditActorType } from '../audit/write.js';
import type { KeycloakAdmin } from '../keycloak/admin.js';
import { ApiError } from '../types.js';
import { assignRole, type AssignRoleInput, type RolesDeps, type StaffUser } from './service.js';

export interface InviteUserInput {
  email: string;
  displayName: string;
  /** Optional first role, assigned through `assignRole` after the user exists (not in the HTTP body). */
  initialRole?: Omit<AssignRoleInput, 'staffUserId'>;
}

export interface InviteUserDeps extends RolesDeps {
  /** Service-account client for the staff realm (`createKeycloakAdmin()`). */
  keycloak: KeycloakAdmin;
}

export interface InviteUserResult {
  user: StaffUser;
  /** The Keycloak user id (= `staff_user.keycloak_subject`). */
  subject: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function actorOf(db: RolesDeps['db']): { id: string | null; type: AuditActorType } {
  const id = db.context.actorId ?? null;
  return { id, type: id ? 'staff' : 'system' };
}

export async function inviteUser(
  deps: InviteUserDeps,
  input: InviteUserInput,
): Promise<InviteUserResult> {
  const email = (input.email ?? '').trim().toLowerCase();
  const displayName = (input.displayName ?? '').trim();
  if (!EMAIL.test(email)) {
    throw new ApiError(400, 'validation_error', 'email must be an address', { field: 'email' });
  }
  if (!displayName) {
    throw new ApiError(400, 'validation_error', 'display_name is required', {
      field: 'display_name',
    });
  }
  const { db, keycloak } = deps;
  // The mirror is the source of truth for "already invited" (409 before Keycloak is touched); Keycloak's own
  // 409 (a user there but no row here, e.g. created through the console) maps to the same conflict.
  const existing = await db.query('SELECT id FROM staff_user WHERE email = $1', [email]);
  if (existing.rowCount) {
    throw new ApiError(409, 'conflict', 'a staff user with this email already exists', {
      field: 'email',
    });
  }

  const created = await keycloak.createUser({ email, displayName });
  let user: StaffUser;
  try {
    user = await db.transaction(async (tx) => {
      const ins = await tx.query<{
        id: string;
        email: string;
        display_name: string;
        status: 'active' | 'disabled';
        last_login_at: Date | null;
      }>(
        `INSERT INTO staff_user (organization_id, keycloak_subject, email, display_name)
         VALUES (app.current_organization_id(), $1, $2, $3)
         RETURNING id, email, display_name, status, last_login_at`,
        [created.subject, email, displayName],
      );
      const r = ins.rows[0]!;
      const api: StaffUser = {
        id: r.id,
        email: r.email,
        display_name: r.display_name,
        status: r.status,
        last_login_at: r.last_login_at?.toISOString() ?? null,
      };
      await audit(tx, {
        action: 'staff_user.create',
        entityType: 'staff_user',
        entityId: r.id,
        before: null,
        after: {
          ...api,
          keycloak_subject: created.subject,
          required_actions: created.requiredActions,
        },
        storeId: null,
        actor: actorOf(db),
        requestId: deps.requestId ?? null,
      });
      return api;
    });
  } catch (err) {
    // Compensate: no row → no Keycloak user either, so the next invite of this email starts clean.
    await keycloak.deleteUser(created.subject).catch(() => undefined);
    const pg = err as { code?: string };
    if (pg?.code === '23505') {
      throw new ApiError(409, 'conflict', 'a staff user with this email already exists', {
        field: 'email',
      });
    }
    throw err;
  }

  if (input.initialRole) {
    await assignRole(deps, { ...input.initialRole, staffUserId: user.id });
  }
  return { user, subject: created.subject };
}
