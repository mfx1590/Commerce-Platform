import { listAuditLog, listUsers } from '@/lib/api/admin';
import type { AdminComponents, AdminError } from '@/lib/api/admin-client';
import { toAuditRows, type AuditRow } from './projection';
import { isServiceAccount } from '@/lib/roles';

type StaffUser = AdminComponents['StaffUser'];
type AuditEntry = AdminComponents['AuditEntry'];

export const ACTIVITY_PAGE_SIZE = 20;
/** More payments than this on one order does not happen; the merge stays bounded. */
const MAX_PAYMENTS = 5;

export interface ActivityData {
  rows: AuditRow[];
  total: number;
  page: number;
  /** Set when the audit read itself failed — the panel shows the refusal, not an empty table. */
  error?: { status: number; error: AdminError };
}

/**
 * The audit read for one entity, reduced to rendered rows **here, on the server**.
 *
 * The fetching lives in this module rather than inside the panel so the panel stays a synchronous
 * component: a page that embeds an async child cannot be rendered by the screen tests (and the
 * page is the right place for its own data anyway). The raw `before`/`after` bodies die in
 * `toAuditRows` and never reach a client component.
 *
 * **Actor names need `owner` on `organization:hq`** — that is `listUsers`' permission. A store
 * admin is refused there, so the lookup is allowed to fail: the history still renders, with the
 * actor labelled "Unknown staff (<short id>)". Losing the whole panel because names are not
 * available would be the worse trade.
 */
export async function loadActivity({
  storeId,
  entityType,
  entityId,
  page = 1,
}: {
  storeId: string;
  entityType: string;
  entityId: string;
  page?: number;
}): Promise<ActivityData> {
  const [entries, users] = await Promise.all([
    listAuditLog({
      store_id: storeId,
      entity_type: entityType,
      entity_id: entityId,
      page,
      limit: ACTIVITY_PAGE_SIZE,
    }),
    listUsers({ limit: 100 }),
  ]);

  if (!entries.ok) {
    return { rows: [], total: 0, page, error: { status: entries.status, error: entries.error } };
  }
  return {
    rows: toAuditRows(entries.data.items, { staff: staffMap(users), isServiceAccount }),
    total: entries.data.total,
    page,
  };
}

/**
 * The audit rows for an order, which are its PAYMENTS' rows: nothing in the core writes an
 * `entity_type: 'order'` row. `listAuditLog` takes one `entity_id`, so the payments are fetched in
 * parallel and merged newest-first, bounded at {@link MAX_PAYMENTS} and capped at one page —
 * paging a merge of N queries would misstate the ordering.
 */
export async function loadOrderPaymentActivity(
  storeId: string,
  paymentIds: readonly string[],
): Promise<ActivityData> {
  const ids = paymentIds.slice(0, MAX_PAYMENTS);
  if (ids.length === 0) return { rows: [], total: 0, page: 1 };

  const [results, users] = await Promise.all([
    Promise.all(
      ids.map((id) =>
        listAuditLog({
          store_id: storeId,
          entity_type: 'payment',
          entity_id: id,
          limit: ACTIVITY_PAGE_SIZE,
        }),
      ),
    ),
    listUsers({ limit: 100 }),
  ]);

  const entries: AuditEntry[] = results
    .flatMap((result) => (result.ok ? result.data.items : []))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, ACTIVITY_PAGE_SIZE);

  if (entries.length === 0) {
    const failed = results.find((result) => !result.ok);
    if (failed !== undefined && !failed.ok) {
      return { rows: [], total: 0, page: 1, error: { status: failed.status, error: failed.error } };
    }
  }
  return {
    rows: toAuditRows(entries, { staff: staffMap(users), isServiceAccount }),
    total: entries.length,
    page: 1,
  };
}

function staffMap(users: Awaited<ReturnType<typeof listUsers>>): Map<string, StaffUser> {
  return new Map(users.ok ? users.data.items.map((user) => [user.id, user]) : []);
}
