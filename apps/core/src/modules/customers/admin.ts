// Admin API customer operations (#414, Admin API 0.4.11): what support and store admins do with a store's
// customers through the HQ / store admin. Everything runs on the store-scoped tenant client the route hands in
// (RLS keeps every read and write inside that store; the explicit `store_id` predicates are a second fence, not
// the security boundary). Every mutation writes its audit row and its outbox event in the same transaction, and
// neither carries an email, a name or a phone (`email_hash` only, like the self-service routes).
//
// Erased customers stay listable and readable — status `erased`, every personal field already replaced — so
// support can see that an erasure happened; they cannot be updated (404, the record no longer describes a person).
import type { Queryable, ScopedClient } from '@platform/db';
import type { AdminComponents } from '@platform/contracts';
import { writeAudit, type Actor } from '../../lib/audit';
import { AppError, validationError } from '../../lib/errors';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import { customerEmailHash } from './service';

export type AdminCustomer = AdminComponents['schemas']['Customer'];
/** The contract's `Address` (company, line2, region and phone nullable) plus its id and the two default flags. */
export type AdminCustomerAddress = AdminComponents['schemas']['Address'] & {
  id: string;
  is_default_shipping: boolean;
  is_default_billing: boolean;
};
export interface CustomerGroup {
  id: string;
  code: string;
  name: string;
}

export const CUSTOMER_SORT_FIELDS = ['created_at', 'email', 'last_name'] as const;
export type CustomerSortField = (typeof CUSTOMER_SORT_FIELDS)[number];

export interface CustomerListQuery {
  /** Email or name, case-insensitive substring. */
  q?: string;
  group_id?: string;
  sort?: CustomerSortField;
  order?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface AdminCustomerPatch {
  first_name?: string;
  last_name?: string;
  phone?: string;
  customer_group_id?: string | null;
  status?: 'registered' | 'disabled';
}

interface AdminCustomerRow {
  id: string;
  identity_id: string | null;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  customer_group_id: string | null;
  status: AdminCustomer['status'];
  consent: Record<string, unknown> | null;
  created_at: Date | string;
}

const COLS = `id, identity_id, email, first_name, last_name, phone, customer_group_id, status, consent, created_at`;
const ADDRESS_COLS = `id, first_name, last_name, company, line1, line2, city, region, postal_code, country, phone,
  is_default_shipping, is_default_billing`;

/** Whitelisted ORDER BY per contract `sort` value (never interpolate request input into SQL). */
const ORDER_BY: Record<CustomerSortField, string> = {
  created_at: 'created_at',
  email: 'email',
  last_name: 'last_name',
};

const MAX_TEXT = 200;
const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();
const notFound = (id: string) =>
  new AppError('not_found', 'customer not found', { customer_id: id });

export function toAdminCustomer(r: AdminCustomerRow): AdminCustomer {
  return {
    id: r.id,
    identity_id: r.identity_id,
    email: r.email,
    first_name: r.first_name,
    last_name: r.last_name,
    phone: r.phone,
    customer_group_id: r.customer_group_id,
    status: r.status,
    consent: r.consent ?? {},
    created_at: iso(r.created_at),
  };
}

/** Escapes LIKE wildcards so a search for `50%` means the characters, not a pattern. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** `listCustomers`: filters `q` (email or first / last name) and `group_id`; contract sort and paging. */
export async function adminListCustomers(
  client: ScopedClient,
  storeId: string,
  query: CustomerListQuery = {},
): Promise<{ page: number; limit: number; total: number; items: AdminCustomer[] }> {
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(100, Math.max(1, query.limit ?? 20));
  const sort: CustomerSortField = query.sort ?? 'created_at';
  const order = query.sort ? (query.order ?? 'desc') : 'desc';
  const where: string[] = ['store_id = $1'];
  const params: unknown[] = [storeId];
  if (query.q && query.q.trim() !== '') {
    params.push(likePattern(query.q.trim()));
    const p = `$${params.length}`;
    where.push(`(email ILIKE ${p} OR first_name ILIKE ${p} OR last_name ILIKE ${p})`);
  }
  if (query.group_id) {
    params.push(query.group_id);
    where.push(`customer_group_id = $${params.length}`);
  }
  const filter = where.join(' AND ');
  return client.transaction(async (tx) => {
    const total = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM customer WHERE ${filter}`,
      params,
    );
    const rows = await tx.query<AdminCustomerRow>(
      `SELECT ${COLS} FROM customer WHERE ${filter}
       ORDER BY ${ORDER_BY[sort]} ${order === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, id
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    );
    return {
      page,
      limit,
      total: Number(total.rows[0]?.n ?? 0),
      items: rows.rows.map(toAdminCustomer),
    };
  });
}

async function loadCustomer(
  tx: Queryable,
  storeId: string,
  customerId: string,
  lock = false,
): Promise<AdminCustomerRow> {
  const r = await tx.query<AdminCustomerRow>(
    `SELECT ${COLS} FROM customer WHERE id = $1 AND store_id = $2${lock ? ' FOR NO KEY UPDATE' : ''}`,
    [customerId, storeId],
  );
  const row = r.rows[0];
  if (!row) throw notFound(customerId);
  return row;
}

/** `getCustomer`: 404 for an unknown id and for another store's customer (RLS makes the two indistinguishable). */
export async function adminGetCustomer(
  client: ScopedClient,
  storeId: string,
  customerId: string,
): Promise<AdminCustomer> {
  return client.transaction(async (tx) =>
    toAdminCustomer(await loadCustomer(tx, storeId, customerId)),
  );
}

/** `listCustomerAddresses`: the customer's saved addresses, defaults first. 404 like `getCustomer`. */
export async function adminListCustomerAddresses(
  client: ScopedClient,
  storeId: string,
  customerId: string,
): Promise<AdminCustomerAddress[]> {
  return client.transaction(async (tx) => {
    await loadCustomer(tx, storeId, customerId);
    const r = await tx.query<AdminCustomerAddress>(
      `SELECT ${ADDRESS_COLS} FROM customer_address WHERE customer_id = $1 AND store_id = $2
       ORDER BY is_default_shipping DESC, is_default_billing DESC, created_at, id`,
      [customerId, storeId],
    );
    return r.rows;
  });
}

/** `listCustomerGroups`: the store's groups by code. */
export async function listCustomerGroups(
  client: ScopedClient,
  storeId: string,
): Promise<CustomerGroup[]> {
  const r = await client.query<CustomerGroup>(
    'SELECT id, code, name FROM customer_group WHERE store_id = $1 ORDER BY code, id',
    [storeId],
  );
  return r.rows;
}

function cleanText(
  value: string | undefined,
  field: string,
  problems: Record<string, string>,
): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT) problems[field] = `at most ${MAX_TEXT} characters`;
  return trimmed === '' ? null : trimmed; // an empty string clears the field (same rule as the Store API)
}

/**
 * `updateCustomer` (support): names, phone, the customer group (a group of the SAME store, or null) and the
 * status between `registered` and `disabled`. A guest row has no account to enable or disable (400); an erased
 * row is not updatable (404). One `customer.updated` with the sorted changed fields; nothing written when
 * nothing changed.
 */
export async function adminUpdateCustomer(
  client: ScopedClient,
  storeId: string,
  customerId: string,
  patch: AdminCustomerPatch,
  actor: Actor,
): Promise<AdminCustomer> {
  const problems: Record<string, string> = {};
  const first = cleanText(patch.first_name, 'first_name', problems);
  const last = cleanText(patch.last_name, 'last_name', problems);
  const phone = cleanText(patch.phone, 'phone', problems);
  if (patch.status !== undefined && patch.status !== 'registered' && patch.status !== 'disabled') {
    problems.status = 'one of registered, disabled';
  }
  if (Object.keys(problems).length) throw validationError('invalid customer update', problems);

  return client.transaction(async (tx) => {
    const before = await loadCustomer(tx, storeId, customerId, true);
    if (before.status === 'erased') throw notFound(customerId);
    if (patch.status !== undefined && before.status === 'guest') {
      throw validationError('a guest customer has no account to enable or disable', {
        status: 'not applicable to a guest',
      });
    }
    if (patch.customer_group_id) {
      const g = await tx.query('SELECT 1 FROM customer_group WHERE id = $1 AND store_id = $2', [
        patch.customer_group_id,
        storeId,
      ]);
      if (g.rowCount === 0) {
        throw validationError('unknown customer group', {
          customer_group_id: 'not a group of this store',
        });
      }
    }

    const next: Partial<Record<keyof AdminCustomerRow, unknown>> = {};
    if (first !== undefined) next.first_name = first;
    if (last !== undefined) next.last_name = last;
    if (phone !== undefined) next.phone = phone;
    if (patch.customer_group_id !== undefined) next.customer_group_id = patch.customer_group_id;
    if (patch.status !== undefined) next.status = patch.status;
    const changed = (Object.keys(next) as (keyof AdminCustomerRow)[])
      .filter((k) => next[k] !== before[k])
      .sort();
    if (changed.length === 0) return toAdminCustomer(before);

    const sets = changed.map((k, i) => `${k} = $${i + 3}`);
    const after = (
      await tx.query<AdminCustomerRow>(
        `UPDATE customer SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND store_id = $2
         RETURNING ${COLS}`,
        [customerId, storeId, ...changed.map((k) => next[k])],
      )
    ).rows[0]!;

    const organizationId = client.context.organizationId;
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'customer.update',
      entityType: 'customer',
      entityId: customerId,
      // field names and non-personal values only — never a name, a phone or an email
      before: { status: before.status, customer_group_id: before.customer_group_id },
      after: {
        status: after.status,
        customer_group_id: after.customer_group_id,
        changed_fields: changed,
      },
    });
    await withEvents(tx, [
      await buildEvent({
        topic: 'customer.updated',
        organizationId,
        storeId,
        aggregateType: 'customer',
        aggregateId: customerId,
        actor: eventActor(actor),
        payload: {
          customer_id: after.id,
          identity_id: after.identity_id,
          email_hash: customerEmailHash(after.email),
          status: after.status,
          customer_group_id: after.customer_group_id,
          marketing_consent: marketingGranted(after.consent),
          changed_fields: changed,
        },
      }),
    ]);
    return toAdminCustomer(after);
  });
}

/** Only an explicit `marketing_email.granted: true` counts (same rule as the self-service routes). */
function marketingGranted(consent: AdminCustomerRow['consent']): boolean {
  const block = consent?.marketing_email;
  return (
    typeof block === 'object' && block !== null && (block as { granted?: unknown }).granted === true
  );
}
