// GDPR erasure and data export for one customer of one store (#414, Admin API 0.4.11; manager decisions
// 2026-10-08, recorded in README.md "Erasure and export"). Both run on the store-scoped tenant client the route
// hands in, so they can never reach another store's customer.
//
// ERASURE (`eraseCustomer`, store_admin, 202): one transaction — the customer row keeps its id, store, group
// and timestamps; every personal field is replaced (email → `erased+<customer_id>@invalid`, names / phone /
// Keycloak subject → null, consent / metadata → {}), the addresses are deleted, the organization-level
// `customer_identity` is unlinked and deleted when nothing else references it, and ONE `customer.erased` outbox
// row tells every consumer to delete its copies. ORDERS ARE KEPT UNCHANGED, linked by `customer_id` only:
// invoices and transaction records are retained under the legal-obligation exception (GDPR art. 17(3)(b)) —
// manager decision A, on the owner's lawyer-review list. Replay-safe: an erased customer is a no-op (no second
// event).
//
// EXPORT (`buildCustomerExport`): everything held about the customer in this store — the record, the addresses,
// the consent object and the customer's orders with their lines. `exportCustomer` (the 202 + the
// `customer.export_requested` hand-over event) wires to it once events 0.3.2 is on main (#425).
import type { Queryable, ScopedClient } from '@platform/db';
import { writeAudit, type Actor } from '../../lib/audit';
import { AppError } from '../../lib/errors';
import { buildEvent, eventActor, withEvents } from '../../outbox';

const notFound = (id: string) =>
  new AppError('not_found', 'customer not found', { customer_id: id });
const iso = (d: Date | string | null) =>
  d === null ? null : (d instanceof Date ? d : new Date(d)).toISOString();

/** The placeholder an erased customer's email becomes: unique per customer (the column is NOT NULL and unique
 *  per store) and undeliverable by construction (RFC 2606 reserves `.invalid`). */
export const erasedEmail = (customerId: string) => `erased+${customerId}@invalid`;

export interface EraseResult {
  /** false = the customer was already erased: nothing was written. */
  erased: boolean;
}

/**
 * Deletes the identity row when nothing references it any more. Another store's customer (invisible here under
 * RLS) or a merged identity still pointing at it makes the DELETE fail with a foreign-key violation: that is the
 * signal to keep the row, so the delete runs under a savepoint and only that outcome is swallowed.
 */
async function deleteIdentityIfOrphaned(tx: Queryable, identityId: string): Promise<boolean> {
  await tx.query('SAVEPOINT erase_identity');
  try {
    const r = await tx.query('DELETE FROM customer_identity WHERE id = $1', [identityId]);
    await tx.query('RELEASE SAVEPOINT erase_identity');
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT erase_identity');
    if ((err as { code?: string }).code === '23503') return false; // still referenced: keep it
    throw err;
  }
}

export async function eraseCustomer(
  client: ScopedClient,
  storeId: string,
  customerId: string,
  actor: Actor,
): Promise<EraseResult> {
  const organizationId = client.context.organizationId;
  return client.transaction(async (tx) => {
    const r = await tx.query<{ id: string; status: string; identity_id: string | null }>(
      `SELECT id, status, identity_id FROM customer WHERE id = $1 AND store_id = $2 FOR NO KEY UPDATE`,
      [customerId, storeId],
    );
    const row = r.rows[0];
    if (!row) throw notFound(customerId);
    if (row.status === 'erased') return { erased: false };

    const addresses = await tx.query(
      'DELETE FROM customer_address WHERE customer_id = $1 AND store_id = $2',
      [customerId, storeId],
    );
    const erased = await tx.query<{ updated_at: Date }>(
      `UPDATE customer
       SET status = 'erased', email = $3, first_name = NULL, last_name = NULL, phone = NULL,
           keycloak_subject = NULL, identity_id = NULL, consent = '{}'::jsonb, metadata = '{}'::jsonb,
           updated_at = now()
       WHERE id = $1 AND store_id = $2
       RETURNING updated_at`,
      [customerId, storeId, erasedEmail(customerId)],
    );
    const identityDeleted = row.identity_id
      ? await deleteIdentityIfOrphaned(tx, row.identity_id)
      : false;

    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'customer.erase',
      entityType: 'customer',
      entityId: customerId,
      // facts only: no email, name, phone or address ever reaches the audit log
      after: {
        status: 'erased',
        addresses_deleted: addresses.rowCount ?? 0,
        identity_unlinked: row.identity_id !== null,
        identity_deleted: identityDeleted,
      },
    });
    await withEvents(tx, [
      await buildEvent({
        topic: 'customer.erased',
        organizationId,
        storeId,
        aggregateType: 'customer',
        aggregateId: customerId,
        actor: eventActor(actor),
        payload: {
          customer_id: customerId,
          identity_id: row.identity_id,
          erased_at: iso(erased.rows[0]!.updated_at)!,
        },
      }),
    ]);
    return { erased: true };
  });
}

// ------------------------------------------------------------------------------------------------- export

export interface CustomerExportOrderLine {
  sku: string;
  title: string;
  variant_title: string;
  quantity: number;
  unit_price_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
}

export interface CustomerExportOrder {
  id: string;
  display_id: number;
  status: string;
  payment_status: string;
  fulfillment_status: string;
  email: string;
  currency: string;
  shipping_address: Record<string, unknown>;
  billing_address: Record<string, unknown>;
  subtotal_minor: number;
  discount_minor: number;
  shipping_minor: number;
  tax_minor: number;
  total_minor: number;
  placed_at: string;
  lines: CustomerExportOrderLine[];
}

/** The bundle a GDPR export delivers (documented in README.md "Erasure and export"). */
export interface CustomerExport {
  format: 'customer-export/v1';
  generated_at: string;
  store_id: string;
  customer: {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    status: string;
    customer_group_id: string | null;
    created_at: string;
  };
  addresses: Record<string, unknown>[];
  consent: Record<string, unknown>;
  orders: CustomerExportOrder[];
}

/** Money columns are bigint (pg returns strings); every amount in the bundle is a number of minor units. */
const minor = (v: string | number) => Number(v);

/**
 * Builds the export bundle. 404 for an unknown / another store's customer and for an erased one (nothing
 * personal remains — the contract documents only 404). Reads only: one statement at a time on the transaction.
 */
export async function buildCustomerExport(
  client: ScopedClient,
  storeId: string,
  customerId: string,
): Promise<CustomerExport> {
  return client.transaction(async (tx) => {
    const c = await tx.query<{
      id: string;
      email: string;
      first_name: string | null;
      last_name: string | null;
      phone: string | null;
      status: string;
      customer_group_id: string | null;
      consent: Record<string, unknown> | null;
      created_at: Date;
    }>(
      `SELECT id, email, first_name, last_name, phone, status, customer_group_id, consent, created_at
       FROM customer WHERE id = $1 AND store_id = $2`,
      [customerId, storeId],
    );
    const customer = c.rows[0];
    if (!customer || customer.status === 'erased') throw notFound(customerId);

    const addresses = await tx.query<Record<string, unknown>>(
      `SELECT first_name, last_name, company, line1, line2, city, region, postal_code, country, phone,
              is_default_shipping, is_default_billing
       FROM customer_address WHERE customer_id = $1 AND store_id = $2 ORDER BY created_at, id`,
      [customerId, storeId],
    );
    const orders = await tx.query<{
      id: string;
      display_id: string;
      status: string;
      payment_status: string;
      fulfillment_status: string;
      email: string;
      currency: string;
      shipping_address: Record<string, unknown>;
      billing_address: Record<string, unknown>;
      subtotal_minor: string;
      discount_minor: string;
      shipping_minor: string;
      tax_minor: string;
      total_minor: string;
      placed_at: Date;
    }>(
      `SELECT id, display_id, status, payment_status, fulfillment_status, email, currency, shipping_address,
              billing_address, subtotal_minor, discount_minor, shipping_minor, tax_minor, total_minor, placed_at
       FROM "order" WHERE customer_id = $1 AND store_id = $2 ORDER BY placed_at, id`,
      [customerId, storeId],
    );
    const ids = orders.rows.map((o) => o.id);
    const lines = ids.length
      ? await tx.query<{
          order_id: string;
          sku: string;
          title: string;
          variant_title: string;
          quantity: number;
          unit_price_minor: string;
          discount_minor: string;
          tax_minor: string;
          total_minor: string;
        }>(
          `SELECT order_id, sku, title, variant_title, quantity, unit_price_minor, discount_minor, tax_minor,
                  total_minor
           FROM order_line_item WHERE order_id = ANY($1::uuid[]) AND store_id = $2 ORDER BY created_at, id`,
          [ids, storeId],
        )
      : { rows: [] };

    return {
      format: 'customer-export/v1',
      generated_at: new Date().toISOString(),
      store_id: storeId,
      customer: {
        id: customer.id,
        email: customer.email,
        first_name: customer.first_name,
        last_name: customer.last_name,
        phone: customer.phone,
        status: customer.status,
        customer_group_id: customer.customer_group_id,
        created_at: iso(customer.created_at)!,
      },
      addresses: addresses.rows,
      consent: customer.consent ?? {},
      orders: orders.rows.map((o) => ({
        id: o.id,
        display_id: Number(o.display_id),
        status: o.status,
        payment_status: o.payment_status,
        fulfillment_status: o.fulfillment_status,
        email: o.email,
        currency: o.currency,
        shipping_address: o.shipping_address,
        billing_address: o.billing_address,
        subtotal_minor: minor(o.subtotal_minor),
        discount_minor: minor(o.discount_minor),
        shipping_minor: minor(o.shipping_minor),
        tax_minor: minor(o.tax_minor),
        total_minor: minor(o.total_minor),
        placed_at: iso(o.placed_at)!,
        lines: lines.rows
          .filter((l) => l.order_id === o.id)
          .map((l) => ({
            sku: l.sku,
            title: l.title,
            variant_title: l.variant_title,
            quantity: l.quantity,
            unit_price_minor: minor(l.unit_price_minor),
            discount_minor: minor(l.discount_minor),
            tax_minor: minor(l.tax_minor),
            total_minor: minor(l.total_minor),
          })),
      })),
    };
  });
}
