import Link from 'next/link';
import { HqSectionGuard } from '@/components/shell/section-guard';
import { RequestErrorPanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { listAuditLog, listStores, listUserRoles, listUsers } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { loadPrincipal } from '@/lib/principal';
import {
  AssignRoleForm,
  InviteUserForm,
  RevokeAssignmentButton,
  type StoreOption,
} from './role-forms';

export const dynamic = 'force-dynamic';

type RoleAssignment = AdminComponents['RoleAssignment'];
type AuditEntry = AdminComponents['AuditEntry'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatTime(value: string | null): string {
  return value === null ? 'never' : value.replace('T', ' ').slice(0, 16);
}

/**
 * HQ · Roles (#428): staff users, their relations on the organization and on stores, invite,
 * assign and revoke, and each person's audit entries. Owner on organization:hq only — the section
 * guard refuses everyone else, and every mutation is re-checked server-side before the API
 * (`src/app/actions/roles.ts`). Audit entries are read per store the person is assigned to, with
 * `actor_id` (the contract's `listAuditLog` is `viewer` on `store:{store_id}`); only the time,
 * the action and the entity are shown — never the before/after bodies.
 */
export default async function RolesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const selected = typeof raw['user'] === 'string' && UUID.test(raw['user']) ? raw['user'] : null;

  const [principal, users, stores] = await Promise.all([
    loadPrincipal(),
    listUsers(),
    listStores({ limit: 100 }),
  ]);
  const organizationId = principal.ok ? principal.data.organization.id : '';
  const storeOptions: StoreOption[] = stores.ok
    ? stores.data.items.map((store) => ({ id: store.id, label: `${store.name} (${store.code})` }))
    : [];
  const storeLabel = new Map(storeOptions.map((store) => [store.id, store.label]));
  const objectLabel = (assignment: RoleAssignment) =>
    assignment.object_type === 'organization'
      ? 'organization:hq'
      : (storeLabel.get(assignment.object_id) ?? assignment.object_id);

  const person =
    selected !== null && users.ok
      ? users.data.items.find((user) => user.id === selected)
      : undefined;
  const roles = person !== undefined ? await listUserRoles(person.id) : null;
  const assignedStores =
    roles !== null && roles.ok
      ? [
          ...new Set(
            roles.data.items
              .filter((assignment) => assignment.object_type === 'store')
              .map((assignment) => assignment.object_id),
          ),
        ]
      : [];
  const audit =
    person !== undefined
      ? await Promise.all(
          assignedStores.map(async (storeId) => ({
            storeId,
            result: await listAuditLog({ actor_id: person.id, store_id: storeId, limit: 20 }),
          })),
        )
      : [];

  return (
    <HqSectionGuard id="roles">
      <div className="space-y-6">
        <Card>
          <CardHeader
            title="Staff users"
            description="Everyone who can sign in to the admin, and the relations they hold."
          />
          <CardBody>
            {!users.ok ? (
              <RequestErrorPanel status={users.status} error={users.error} />
            ) : users.data.items.length === 0 ? (
              <p className="text-muted text-sm">No staff users yet.</p>
            ) : (
              <table className="w-full text-sm" aria-label="Staff users">
                <thead className="text-muted text-left text-xs">
                  <tr>
                    <th className="py-1">Name</th>
                    <th>Email</th>
                    <th>Status</th>
                    <th>Last sign-in</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-line divide-y">
                  {users.data.items.map((user) => (
                    <tr key={user.id} aria-current={user.id === selected ? 'true' : undefined}>
                      <td className="py-2 font-medium">{user.display_name}</td>
                      <td className="font-mono text-xs">{user.email}</td>
                      <td>
                        <Badge tone={user.status === 'active' ? 'success' : 'warning'}>
                          {user.status}
                        </Badge>
                      </td>
                      <td className="text-muted text-xs">{formatTime(user.last_login_at)}</td>
                      <td className="text-right">
                        <Link
                          href={`/roles?user=${user.id}`}
                          className="text-accent text-sm hover:underline"
                          aria-label={`Manage ${user.display_name}`}
                        >
                          Manage
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>

        {person !== undefined && (
          <Card>
            <CardHeader
              title={person.display_name}
              description={`${person.email} — relations, and what this person changed.`}
            />
            <CardBody className="space-y-5">
              {roles !== null && !roles.ok ? (
                <RequestErrorPanel status={roles.status} error={roles.error} />
              ) : roles !== null && roles.data.items.length === 0 ? (
                <p className="text-muted text-sm">No relations yet — assign one below.</p>
              ) : (
                <ul className="divide-line divide-y text-sm" aria-label="Relations">
                  {roles?.ok &&
                    roles.data.items.map((assignment) => {
                      const label = `${assignment.relation} on ${objectLabel(assignment)}`;
                      return (
                        <li key={assignment.id} className="flex flex-wrap items-center gap-3 py-2">
                          <Badge>{assignment.relation}</Badge>
                          <span>{objectLabel(assignment)}</span>
                          <span className="text-muted text-xs">
                            since {formatTime(assignment.created_at)}
                          </span>
                          <span className="ml-auto">
                            <RevokeAssignmentButton
                              userId={person.id}
                              assignmentId={assignment.id}
                              label={label}
                            />
                          </span>
                        </li>
                      );
                    })}
                </ul>
              )}
              <AssignRoleForm
                userId={person.id}
                organizationId={organizationId}
                stores={storeOptions}
              />

              <section className="space-y-2" aria-label="Audit entries">
                <h3 className="text-sm font-semibold">What this person changed</h3>
                {assignedStores.length === 0 ? (
                  <p className="text-muted text-sm">
                    Audit entries are listed per store; this person holds no store relation.
                  </p>
                ) : (
                  audit.map(({ storeId, result }) => (
                    <div key={storeId} className="space-y-1">
                      <h4 className="text-muted text-xs">{storeLabel.get(storeId) ?? storeId}</h4>
                      {!result.ok ? (
                        <RequestErrorPanel status={result.status} error={result.error} />
                      ) : result.data.items.length === 0 ? (
                        <p className="text-muted text-sm">Nothing recorded.</p>
                      ) : (
                        <ul className="text-sm" aria-label={`Audit entries for ${storeId}`}>
                          {result.data.items.map((entry: AuditEntry) => (
                            <li key={entry.id} className="flex gap-3 py-0.5">
                              <span className="text-muted font-mono text-xs">
                                {formatTime(entry.created_at)}
                              </span>
                              <span>{entry.action}</span>
                              <span className="text-muted">{entry.entity_type}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))
                )}
              </section>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Invite a staff user"
            description="Creates the person in Keycloak; an initial relation can be granted at once."
          />
          <CardBody>
            <InviteUserForm organizationId={organizationId} stores={storeOptions} />
          </CardBody>
        </Card>
      </div>
    </HqSectionGuard>
  );
}
