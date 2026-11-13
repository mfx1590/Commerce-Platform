import { listAuditLog, listStores, listUsers } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { auditCsv, toAuditRows } from '@/lib/audit/projection';
import { parseAuditQuery, toListQuery, toSearch } from '@/lib/audit/query';
import { isServiceAccount } from '@/lib/roles';

type StaffUser = AdminComponents['StaffUser'];

export const dynamic = 'force-dynamic';

/**
 * The audit view's visible page as CSV (#870 wave 1 item 3).
 *
 * The same `parseAuditQuery` / `toListQuery` the page uses, so "export what I am looking at" is
 * true rather than nearly true — and the same `AuditRow`s, so the file carries the redacted
 * summary and the changed field NAMES. A `before`/`after` body cannot reach a spreadsheet through
 * this route, because the rows it serialises do not have one.
 *
 * Permission is the API's: `listAuditLog` is `viewer` on the store, the core decides scope from
 * the caller's own relations, and a refusal is forwarded with its status rather than becoming an
 * empty file that looks like "nothing happened".
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = parseAuditQuery(url.searchParams);

  const [entries, stores, users] = await Promise.all([
    listAuditLog(toListQuery(query)),
    listStores({ limit: 100 }),
    listUsers({ limit: 100 }),
  ]);

  if (!entries.ok) {
    return new Response(JSON.stringify(entries.error), {
      status: entries.status === 0 ? 502 : entries.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
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
