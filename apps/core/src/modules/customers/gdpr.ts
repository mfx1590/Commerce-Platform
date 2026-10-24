// GDPR erasure and data export for one customer of one store (#414, Admin API 0.4.12 / events 0.3.2; manager decisions
// 2026-10-08, recorded in README.md "Erasure and export"). Both run on the store-scoped tenant client the route
// hands in, so they can never reach another store's customer.
//
// ERASURE (`eraseCustomer`, store_admin, 202; `eraseMe`, the customer's own `DELETE /store/customers/me`, #470):
// one transaction — the customer row keeps its id, store, group and timestamps; every personal field is
// replaced (email → `erased+<customer_id>@invalid`, names / phone → null, consent / metadata → {}), the
// addresses are deleted, the organization-level
// `customer_identity` is unlinked and deleted when nothing else references it, and ONE `customer.erased` outbox
// row tells every consumer to delete its copies. The KEYCLOAK SUBJECT STAYS on the erased row as an erasure
// tombstone (manager decision 2026-10-18, #482, on the owner's lawyer list): it is an opaque IdP identifier,
// not personal data, and it is what makes the same login a 401 on every route afterwards and a repeated
// `DELETE /me` a 202 no-op — with the subject nulled and the email replaced, nothing would find the erased
// row and the next `/me` would silently provision a fresh account. The Keycloak user itself is deleted by a
// separate job (REQUEST #483); the tombstone is meaningless once that has happened.
//
// ORDERS ARE KEPT UNCHANGED, linked by `customer_id` only:
// invoices and transaction records are retained under the legal-obligation exception (GDPR art. 17(3)(b)) —
// manager decision A, on the owner's lawyer-review list. Replay-safe: an erased customer is a no-op (no second
// event).
//
// EXPORT (`buildCustomerExport`): everything held about the customer in this store — the record, the addresses,
// the consent object and the customer's orders with their lines. `exportCustomer` (the 202 + the
// `customer.export_requested` hand-over event, events 0.3.2 / #425; v2 since #482 carries who asked:
// `requested_by_type` staff or customer) is `requestCustomerExport` below — the Admin API and the customer's own
// `POST /store/customers/me/export` both go through it.
import type { Queryable, ScopedClient } from '@platform/db';
import { writeAudit, type Actor } from '../../lib/audit';
import { AppError } from '../../lib/errors';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import { consentLedger, type ConsentDecision } from './consent-ledger';
import { eraseIdentity, unlinkIdentity, type EraseIdentityResult } from './identity';
import { customerEmailHash, resolveIn } from './service';
import type { CustomerIdentity, CustomerScope } from './types';

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
 * Cross-brand erasure of one identity (#473): every store row of the person, each through `eraseIn`, then the
 * identity. Built for the owner's decision on self-service deletion and NOT wired to `eraseMe` (per brand until
 * decided). Takes an organization client (HQ / jobs); a store client cannot see the identity.
 */
export async function eraseCustomerIdentity(
  client: ScopedClient,
  identityId: string,
  actor: Actor,
): Promise<EraseIdentityResult> {
  return eraseIdentity(client, identityId, actor, eraseIn);
}

export async function eraseCustomer(
  client: ScopedClient,
  storeId: string,
  customerId: string,
  actor: Actor,
): Promise<EraseResult> {
  const organizationId = client.context.organizationId;
  return client.transaction((tx) => eraseIn(tx, organizationId, storeId, customerId, actor));
}

/**
 * `DELETE /store/customers/me` (#470, Store API 0.5.6): the customer erases their own row in THIS store — only
 * this store's (whether a deletion spans every brand of the organization is the owner's open decision). A
 * subject with NO row here is a 202 no-op: nothing is provisioned (#487 review — provisioning first would put
 * a `customer.created` with the real email hash into the outbox for a person who asked to be deleted), and so
 * is an already erased row (the tombstone subject finds it before `resolveIn` would answer 401). Otherwise
 * `resolveIn` locks the row and judges its status, then the erasure runs under that lock.
 */
export async function eraseMe(
  client: ScopedClient,
  scope: CustomerScope,
  identity: CustomerIdentity,
): Promise<EraseResult> {
  return client.transaction(async (tx) => {
    const existing = await tx.query<{ status: string }>(
      'SELECT status FROM customer WHERE store_id = $1 AND keycloak_subject = $2',
      [scope.storeId, identity.subject],
    );
    if (!existing.rows[0] || existing.rows[0].status === 'erased') return { erased: false };
    const { row } = await resolveIn(tx, scope, identity);
    const actor: Actor = { id: row.id, type: 'customer', requestId: scope.requestId ?? null };
    return eraseIn(tx, scope.organizationId, scope.storeId, row.id, actor);
  });
}

async function eraseIn(
  tx: Queryable,
  organizationId: string,
  storeId: string,
  customerId: string,
  actor: Actor,
): Promise<EraseResult> {
  {
    const r = await tx.query<{
      id: string;
      status: string;
      identity_id: string | null;
      email: string;
    }>(
      `SELECT id, status, identity_id, email FROM customer WHERE id = $1 AND store_id = $2 FOR NO KEY UPDATE`,
      [customerId, storeId],
    );
    const row = r.rows[0];
    if (!row) throw notFound(customerId);
    if (row.status === 'erased') return { erased: false };
    // customer.erased v2 (#580): the hash of the e-mail AS IT WAS, taken here — inside the transaction, before the
    // row is tombstoned — so a consumer keyed by the hash (the CDP's guest profiles) can suppress its copy. Never the
    // tombstone's hash: `erased+<id>@invalid` matches nothing downstream. The same house hash as customer.created.
    const emailHash = customerEmailHash(row.email);

    const addresses = await tx.query(
      'DELETE FROM customer_address WHERE customer_id = $1 AND store_id = $2',
      [customerId, storeId],
    );
    // the consent ledger (#471) goes with the row; the projection is emptied with `consent = {}` below
    const consents = await tx.query(
      'DELETE FROM customer_consent WHERE customer_id = $1 AND store_id = $2',
      [customerId, storeId],
    );
    // every export of the customer, ready bundles included: a bundle is the customer's whole personal data
    // (#472, manager decision 2026-10-18); the request events in the outbox stay (ids only)
    const exports = await tx.query(
      'DELETE FROM customer_export WHERE customer_id = $1 AND store_id = $2',
      [customerId, storeId],
    );
    // the cross-brand identity (#473): unlinked through the organization-scope function — this transaction
    // cannot see the table — and deleted when nothing else references it (another brand's row of the same
    // person, or a merged guest identity, keeps it)
    const identityDeleted = row.identity_id ? await unlinkIdentity(tx, customerId) : false;
    const erased = await tx.query<{ updated_at: Date }>(
      `UPDATE customer
       SET status = 'erased', email = $3, first_name = NULL, last_name = NULL, phone = NULL,
           identity_id = NULL, consent = '{}'::jsonb, metadata = '{}'::jsonb,
           updated_at = now()
       WHERE id = $1 AND store_id = $2
       RETURNING updated_at`,
      [customerId, storeId, erasedEmail(customerId)],
    );
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
        consents_deleted: consents.rowCount ?? 0,
        exports_deleted: exports.rowCount ?? 0,
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
          email_hash: emailHash,
          erased_at: iso(erased.rows[0]!.updated_at)!,
        },
      }),
    ]);
    return { erased: true };
  }
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
  /** The consent ledger (#471), oldest first: every decision with its source and policy version. */
  consents: Array<Omit<ConsentDecision, 'id'>>;
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

    const consents = (await consentLedger(tx, customerId))
      .reverse()
      .map(({ id: _id, ...decision }) => decision);

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
      consents,
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

/**
 * `exportCustomer` (store_admin, 202): records the request — one audit row and one `customer.export_requested`
 * outbox row PER REQUEST (no dedupe: each request is its own delivery), ids only. The delivery job of Integration
 * 2b consumes the event and calls `buildCustomerExport`. 404 for an unknown, another store's or an erased customer.
 */
export async function requestCustomerExport(
  client: ScopedClient,
  storeId: string,
  customerId: string,
  actor: Actor,
): Promise<void> {
  const requestedBy = actor.id;
  // `requested_by` is a staff user or the customer (events v2, #482): never the system actor.
  if (!requestedBy || actor.type === 'system') {
    throw new AppError('forbidden', 'an export must be requested by a staff user or the customer');
  }
  const requestedByType = actor.type;
  const organizationId = client.context.organizationId;
  await client.transaction(async (tx) => {
    const r = await tx.query<{ status: string }>(
      'SELECT status FROM customer WHERE id = $1 AND store_id = $2',
      [customerId, storeId],
    );
    if (!r.rows[0] || r.rows[0].status === 'erased') throw notFound(customerId);
    const requestedAt = new Date();
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'customer.export_request',
      entityType: 'customer',
      entityId: customerId,
      after: { requested_at: requestedAt.toISOString() },
    });
    await withEvents(tx, [
      await buildEvent({
        topic: 'customer.export_requested',
        organizationId,
        storeId,
        aggregateType: 'customer',
        aggregateId: customerId,
        actor: eventActor(actor),
        payload: {
          customer_id: customerId,
          requested_by: requestedBy,
          requested_by_type: requestedByType,
          requested_at: requestedAt.toISOString(),
        },
      }),
    ]);
  });
}
