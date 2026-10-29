// Production provisioning of the service accounts (#632; clients from #565 / #622). Idempotent:
// 1. the staff_user row of each service account, with the FIXED id (SEED_IDS.serviceAccounts) and the subject the
//    realm export pins on its service-account user (`seed-<clientId>`): created when missing (audited
//    `staff_user.create`), left as is when present; a row whose subject or organization differs is REFUSED, never
//    rewritten;
// 2. its role assignments through `assignRole` (tuple + role_assignment mirror + audit): crm-sync `support` on each
//    named store, analytics-sync `analyst` and `finance` on the organization.
// It never removes anything: an assignment beyond the requested ones is reported (`extra`), for a person to revoke.
// Output is ids, codes and relations only. `dryRun` reads and reports, writes nothing.
import { SEED_IDS, type ScopedClient } from '@platform/db';
import type { Relation } from '@platform/contracts';
import { audit, type AuditActorType } from '../audit/write.js';
import { ApiError } from '../types.js';
import { assignRole, type RolesDeps } from './service.js';

export interface ServiceAccount {
  clientId: 'crm-sync' | 'analytics-sync';
  staffUserId: string;
  subject: string;
  email: string;
  displayName: string;
}

/** The two service accounts: the same rows the dev seed writes (packages/db seed). */
export const SERVICE_ACCOUNTS: readonly ServiceAccount[] = Object.freeze([
  {
    clientId: 'crm-sync',
    staffUserId: SEED_IDS.serviceAccounts.crmSync,
    subject: 'seed-crm-sync',
    email: 'crm-sync@service.invalid',
    displayName: 'CRM sync (service)',
  },
  {
    clientId: 'analytics-sync',
    staffUserId: SEED_IDS.serviceAccounts.analyticsSync,
    subject: 'seed-analytics-sync',
    email: 'analytics-sync@service.invalid',
    displayName: 'Analytics sync (service)',
  },
]);

export interface ProvisionServiceAccountsInput {
  /** Store codes crm-sync gets `support` on (at least one; each must be a store of the organization). */
  crmSyncStoreCodes: string[];
  dryRun?: boolean;
}

export interface ProvisionedAssignment {
  clientId: string;
  relation: Relation;
  object: string;
  /** created = written by this run (or, dry run, would be); present = already there. */
  status: 'created' | 'present';
}

export interface ProvisionServiceAccountsReport {
  dryRun: boolean;
  users: { clientId: string; staffUserId: string; status: 'created' | 'present' }[];
  assignments: ProvisionedAssignment[];
  /** Assignments the accounts hold beyond the requested ones — never removed here. */
  extra: { clientId: string; relation: string; object: string }[];
}

function actorOf(db: ScopedClient): { id: string | null; type: AuditActorType } {
  const id = db.context.actorId ?? null;
  return { id, type: id ? 'staff' : 'system' };
}

export async function provisionServiceAccounts(
  deps: RolesDeps,
  input: ProvisionServiceAccountsInput,
): Promise<ProvisionServiceAccountsReport> {
  const { db } = deps;
  const dryRun = input.dryRun === true;
  const codes = [...new Set(input.crmSyncStoreCodes.map((c) => c.trim()).filter(Boolean))];
  if (codes.length === 0) {
    throw new ApiError(400, 'validation_error', 'crm-sync needs at least one store code', {
      field: 'crm_sync_store_codes',
    });
  }

  // Resolve everything BEFORE any write: an unknown store code changes nothing.
  const org = await db.query<{ id: string; slug: string }>(
    'SELECT id, slug FROM organization WHERE id = app.current_organization_id()',
  );
  if (org.rowCount !== 1) throw new ApiError(400, 'validation_error', 'organization not found');
  const { id: organizationId, slug } = org.rows[0]!;
  const stores = await db.query<{ id: string; code: string }>(
    'SELECT id, code FROM store WHERE code = ANY($1) ORDER BY code',
    [codes],
  );
  const unknown = codes.filter((c) => !stores.rows.some((s) => s.code === c));
  if (unknown.length > 0) {
    throw new ApiError(400, 'validation_error', `unknown store code(s): ${unknown.join(', ')}`, {
      field: 'crm_sync_store_codes',
    });
  }

  const wanted: {
    account: ServiceAccount;
    relation: Relation;
    objectType: 'store' | 'organization';
    objectId: string;
    object: string;
  }[] = [];
  for (const account of SERVICE_ACCOUNTS) {
    if (account.clientId === 'crm-sync') {
      for (const s of stores.rows) {
        wanted.push({
          account,
          relation: 'support',
          objectType: 'store',
          objectId: s.id,
          object: `store:${s.code}`,
        });
      }
    } else {
      for (const relation of ['analyst', 'finance'] as const) {
        wanted.push({
          account,
          relation,
          objectType: 'organization',
          objectId: organizationId,
          object: `organization:${slug}`,
        });
      }
    }
  }

  const report: ProvisionServiceAccountsReport = { dryRun, users: [], assignments: [], extra: [] };

  for (const account of SERVICE_ACCOUNTS) {
    const row = await db.query<{ keycloak_subject: string; organization_id: string }>(
      'SELECT keycloak_subject, organization_id FROM staff_user WHERE id = $1',
      [account.staffUserId],
    );
    const bySubject = await db.query<{ id: string }>(
      'SELECT id FROM staff_user WHERE keycloak_subject = $1 AND id <> $2',
      [account.subject, account.staffUserId],
    );
    if (bySubject.rowCount) {
      throw new ApiError(
        409,
        'conflict',
        `${account.clientId}: another staff user already has its subject`,
      );
    }
    if (row.rowCount) {
      if (row.rows[0]!.keycloak_subject !== account.subject) {
        throw new ApiError(
          409,
          'conflict',
          `${account.clientId}: staff user ${account.staffUserId} has another subject — refusing to rewrite it`,
        );
      }
      report.users.push({
        clientId: account.clientId,
        staffUserId: account.staffUserId,
        status: 'present',
      });
      continue;
    }
    if (!dryRun) {
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO staff_user (id, organization_id, keycloak_subject, email, display_name)
           VALUES ($1, app.current_organization_id(), $2, $3, $4)`,
          [account.staffUserId, account.subject, account.email, account.displayName],
        );
        await audit(tx, {
          action: 'staff_user.create',
          entityType: 'staff_user',
          entityId: account.staffUserId,
          before: null,
          after: {
            id: account.staffUserId,
            keycloak_subject: account.subject,
            service_client: account.clientId,
          },
          storeId: null,
          actor: actorOf(db),
          requestId: deps.requestId ?? null,
        });
      });
    }
    report.users.push({
      clientId: account.clientId,
      staffUserId: account.staffUserId,
      status: 'created',
    });
  }

  for (const w of wanted) {
    const exists = await db.query(
      `SELECT 1 FROM role_assignment
       WHERE staff_user_id = $1 AND relation = $2 AND object_type = $3 AND object_id = $4`,
      [w.account.staffUserId, w.relation, w.objectType, w.objectId],
    );
    let status: 'created' | 'present' = exists.rowCount ? 'present' : 'created';
    if (!dryRun) {
      // assignRole heals a missing tuple behind an existing mirror row, and never audits a no-op.
      const r = await assignRole(deps, {
        staffUserId: w.account.staffUserId,
        relation: w.relation,
        objectType: w.objectType,
        objectId: w.objectId,
      });
      status = r.created ? 'created' : 'present';
    }
    report.assignments.push({
      clientId: w.account.clientId,
      relation: w.relation,
      object: w.object,
      status,
    });
  }

  const held = await db.query<{
    staff_user_id: string;
    relation: string;
    object_type: string;
    object_id: string;
    code: string | null;
  }>(
    `SELECT ra.staff_user_id, ra.relation, ra.object_type, ra.object_id, s.code
     FROM role_assignment ra LEFT JOIN store s ON ra.object_type = 'store' AND s.id = ra.object_id
     WHERE ra.staff_user_id = ANY($1) ORDER BY ra.staff_user_id, ra.relation, s.code`,
    [SERVICE_ACCOUNTS.map((a) => a.staffUserId)],
  );
  for (const h of held.rows) {
    const account = SERVICE_ACCOUNTS.find((a) => a.staffUserId === h.staff_user_id)!;
    const isWanted = wanted.some(
      (w) =>
        w.account === account &&
        w.relation === h.relation &&
        w.objectType === h.object_type &&
        w.objectId === h.object_id,
    );
    if (!isWanted) {
      report.extra.push({
        clientId: account.clientId,
        relation: h.relation,
        object:
          h.object_type === 'store' ? `store:${h.code ?? h.object_id}` : `organization:${slug}`,
      });
    }
  }
  return report;
}
