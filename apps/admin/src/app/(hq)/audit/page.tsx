import Link from 'next/link';
import { ActivityRows } from '@/components/audit/activity-panel';
import { HqSectionGuard } from '@/components/shell/section-guard';
import { RequestErrorPanel } from '@/components/states/state-panel';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { listAuditLog, listStores, listUsers } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { toAuditRows } from '@/lib/audit/projection';
import {
  AUDITED_ENTITY_TYPES,
  isFiltered,
  parseAuditQuery,
  toListQuery,
  toSearch,
  type AuditQuery,
} from '@/lib/audit/query';
import { isServiceAccount } from '@/lib/roles';

type StaffUser = AdminComponents['StaffUser'];

export const dynamic = 'force-dynamic';

const INPUT =
  'border-line bg-canvas rounded-md border px-2 py-1 text-sm focus:outline-accent min-w-40';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

/**
 * HQ · Audit (#870 wave 1 item 3): every recorded change in the organization, filtered.
 *
 * **Scope is the server's, not this form's.** `listAuditLog` with no `store_id` returns what the
 * caller's own scope allows — organization scope sees every row including the ones with no store,
 * a store-scoped caller sees only their stores — and with `store_id` the core re-checks `viewer`
 * on that store before answering. The store filter here narrows a result the server has already
 * decided; it never widens one.
 *
 * **Nothing raw is rendered.** Rows become `AuditRow`s on the server, so a `before`/`after` body
 * never reaches the browser and never reaches the CSV. See `src/lib/audit/redaction.ts`.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = {
    get: (name: string) => {
      const value = raw[name];
      return typeof value === 'string' && value !== '' ? value : null;
    },
  };
  const query: AuditQuery = parseAuditQuery(params);

  const [entries, stores, users] = await Promise.all([
    listAuditLog(toListQuery(query)),
    listStores({ limit: 100 }),
    listUsers({ limit: 100 }),
  ]);

  const storeLabels = new Map<string, string>(
    stores.ok ? stores.data.items.map((store) => [store.id, `${store.name} (${store.code})`]) : [],
  );
  const staff = new Map<string, StaffUser>(
    users.ok ? users.data.items.map((user) => [user.id, user]) : [],
  );

  const total = entries.ok ? entries.data.total : 0;
  const shown = entries.ok ? entries.data.items.length : 0;
  const first = total === 0 ? 0 : (query.page - 1) * query.limit + 1;
  const hasMore = query.page * query.limit < total;
  const link = (page: number) => `/audit?${toSearch({ ...query, page })}`;

  return (
    <HqSectionGuard id="audit">
      <div className="space-y-6">
        <Card>
          <CardHeader
            title="Audit"
            description="Every change staff made, across the organization. Values are shown only for fields that are safe to print; everything else names the field and withholds the value."
          />
          <CardBody>
            <form method="get" className="flex flex-wrap items-end gap-3">
              <Field label="Store">
                <select name="store_id" defaultValue={query.storeId ?? ''} className={INPUT}>
                  <option value="">All stores</option>
                  {[...storeLabels].map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Entity type">
                <select name="entity_type" defaultValue={query.entityType ?? ''} className={INPUT}>
                  <option value="">All types</option>
                  {AUDITED_ENTITY_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type.replaceAll('_', ' ')}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Actor">
                <select name="actor_id" defaultValue={query.actorId ?? ''} className={INPUT}>
                  <option value="">Anyone</option>
                  {[...staff.values()].map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.display_name}
                      {isServiceAccount(user.id) ? ' (service account)' : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="From (UTC day)">
                <input type="date" name="from" defaultValue={query.from ?? ''} className={INPUT} />
              </Field>
              <Field label="To (UTC day)">
                <input type="date" name="to" defaultValue={query.to ?? ''} className={INPUT} />
              </Field>
              <Field label="Oldest first">
                <select name="order" defaultValue={query.order} className={INPUT}>
                  <option value="desc">Newest first</option>
                  <option value="asc">Oldest first</option>
                </select>
              </Field>
              <button
                type="submit"
                className="border-line bg-canvas rounded-md border px-3 py-1.5 text-sm font-medium"
              >
                Apply
              </button>
              {isFiltered(query) && (
                <Link href="/audit" className="text-accent text-sm hover:underline">
                  Clear filters
                </Link>
              )}
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title={total === 0 ? 'Changes' : `Changes · ${first}–${first + shown - 1} of ${total}`}
            description="The columns below are exactly what the CSV export contains — never a before/after body."
          />
          <CardBody>
            {!entries.ok ? (
              <RequestErrorPanel status={entries.status} error={entries.error} />
            ) : entries.data.items.length === 0 ? (
              <p className="text-muted text-sm">
                {isFiltered(query)
                  ? 'No changes match these filters.'
                  : 'No changes recorded yet in the stores you can see.'}
              </p>
            ) : (
              <div className="space-y-3">
                <ActivityRows
                  rows={toAuditRows(entries.data.items, {
                    staff,
                    stores: storeLabels,
                    isServiceAccount,
                  })}
                  caption="Audit entries"
                  showStore
                />
                <div className="flex items-center gap-3 text-xs">
                  {query.page > 1 && (
                    <Link className="text-accent hover:underline" href={link(query.page - 1)}>
                      ← Newer
                    </Link>
                  )}
                  {hasMore && (
                    <Link className="text-accent hover:underline" href={link(query.page + 1)}>
                      Older →
                    </Link>
                  )}
                  <a
                    className="text-accent ml-auto hover:underline"
                    href={`/audit/export?${toSearch(query)}`}
                  >
                    Export this page as CSV
                  </a>
                </div>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </HqSectionGuard>
  );
}
