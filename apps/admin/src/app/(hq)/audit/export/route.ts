import { listAuditLog, listStores, listUsers } from '@/lib/api/admin';
import type { AdminComponents, AdminError } from '@/lib/api/admin-client';
import { auditCsv, toAuditRows } from '@/lib/audit/projection';
import { parseAuditQuery, toListQuery, toSearch } from '@/lib/audit/query';
import { visibleHqSections } from '@/lib/nav/navigation';
import { HQ_SECTIONS } from '@/lib/nav/sections';
import { loadPrincipal } from '@/lib/principal';
import { isServiceAccount } from '@/lib/roles';

type StaffUser = AdminComponents['StaffUser'];

export const dynamic = 'force-dynamic';

const json = (status: number, error: AdminError) =>
  new Response(JSON.stringify(error), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/** The relation the `audit` section's own catalogue entry asks for, so the two cannot drift. */
const REQUIRED = HQ_SECTIONS.find((section) => section.id === 'audit')?.requires[0] ?? 'owner';

/**
 * The audit view's visible page as CSV (#870 wave 1 item 3).
 *
 * **Gated here, before any API call** (#896 Fable review). A route handler is not a screen: the
 * section guard that hides `/audit` from a non-owner does nothing for a URL typed into the address
 * bar, and `listAuditLog` itself is only `viewer` on a store — so without this check a
 * store-scoped staff user could have downloaded their stores' whole audit log as a file. The
 * handler now resolves the principal and applies the **same** `visibleHqSections` predicate the
 * page uses, from the same catalogue entry: no principal is 401 (a failed `/admin/me` forwards its
 * own status, so a fail-closed 503 stays a 503), a principal without the relation is 403, and
 * neither case reaches the Admin API.
 *
 * Past the gate it uses the page's own `parseAuditQuery` / `toListQuery`, so "export what I am
 * looking at" is true rather than nearly true, and the same `AuditRow`s, so the file carries the
 * redacted summary and the changed field NAMES. A `before`/`after` body cannot reach a spreadsheet
 * through this route, because the rows it serialises do not have one. An API refusal is forwarded
 * with its status rather than becoming an empty file that reads as "nothing happened".
 */
export async function GET(request: Request): Promise<Response> {
  const principal = await loadPrincipal();
  if (!principal.ok) {
    return json(principal.status === 0 ? 502 : principal.status, principal.error);
  }
  if (!visibleHqSections(principal.data).some((section) => section.id === 'audit')) {
    return json(403, {
      code: 'forbidden',
      message: `You need the ${REQUIRED} relation on organization:hq to export the audit log.`,
      details: { relation: REQUIRED, object: 'organization:hq' },
    });
  }

  const url = new URL(request.url);
  const query = parseAuditQuery(url.searchParams);

  const [entries, stores, users] = await Promise.all([
    listAuditLog(toListQuery(query)),
    listStores({ limit: 100 }),
    listUsers({ limit: 100 }),
  ]);

  if (!entries.ok) {
    return json(entries.status === 0 ? 502 : entries.status, entries.error);
  }

  const rows = toAuditRows(entries.data.items, {
    staff: new Map<string, StaffUser>(
      users.ok ? users.data.items.map((user) => [user.id, user]) : [],
    ),
    stores: new Map<string, string>(
      stores.ok
        ? stores.data.items.map((store) => [store.id, `${store.name} (${store.code})`])
        : [],
    ),
    isServiceAccount,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const filtered = toSearch(query) === '' ? 'all' : 'filtered';
  return new Response(auditCsv(rows), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="audit-${filtered}-page${query.page}-${stamp}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
