// Customer self-service over packages/db migration 0005 (`customer`): the store-level customer row of a signed-in
// shopper. There is no "register first" step: every `/store/customers*` route resolves the row from the verified
// token or creates it (#303, manager rulings 2026-10-02). The store comes from the publishable key; the subject
// and the email come from the TOKEN only. One transaction per use case: the row change, one audit row and one
// outbox event commit or roll back together. Nothing here logs, and neither the audit row nor the event carries
// an email or a name.
import { createHash } from 'node:crypto';
import type { Queryable, ScopedClient } from '@platform/db';
import { writeAudit, type Actor } from '../../lib/audit';
import { AppError, conflict, validationError } from '../../lib/errors';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import type {
  Customer,
  CustomerIdentity,
  CustomerRow,
  CustomerScope,
  RegisterCustomerInput,
} from './types';

const COLS = `id, organization_id, store_id, identity_id, keycloak_subject, email, first_name, last_name, phone,
  customer_group_id, status, consent`;

/** Where a consent decision made through the Store API is recorded as coming from (docs/domain.md `consent`). */
const CONSENT_SOURCE = 'storefront';

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** `email_hash` of the events contract: sha256 hex of the trimmed, lowercased email. */
export const customerEmailHash = (email: string): string =>
  createHash('sha256').update(normalizeEmail(email)).digest('hex');

/** `marketing_consent` of the contract: only an explicit `granted: true` counts (same rule as the marketing module). */
function marketingConsent(consent: CustomerRow['consent']): boolean {
  const block = consent?.marketing_email;
  return (
    typeof block === 'object' && block !== null && (block as { granted?: unknown }).granted === true
  );
}

export function toCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    phone: row.phone,
    // `erased` never leaves this module: an erased row is a 401 before anything is rendered.
    status: row.status as Customer['status'],
    marketing_consent: marketingConsent(row.consent),
  };
}

const notActive = () => new AppError('unauthorized', 'customer account is not active');
/** The contract's 409 on the customer operations. Deliberately carries nothing about the other row. */
const emailTaken = () => conflict('This email already has an account', {});

/** Disabled and erased customers are a 401 on every customer route and are never provisioned again. */
function active(row: CustomerRow): CustomerRow {
  if (row.status === 'disabled' || row.status === 'erased') throw notActive();
  return row;
}

type Outcome = 'existing' | 'created' | 'adopted';

interface Located {
  row: CustomerRow;
  outcome: Outcome;
  /** Column names an adoption changed (never values). */
  changed: string[];
}

/**
 * Finds the customer row for the token's subject in this store, or creates it, or — when the token's email is
 * already on a row — applies the collision rule:
 *
 *  - the token's email is verified AND that row has no subject → the row is adopted (it gets the subject and
 *    becomes `registered`): a guest who later signs in keeps one customer row;
 *  - anything else (email not verified, or the row belongs to another identity) → 409, nothing written.
 *
 * Concurrent first requests of one subject: `ON CONFLICT DO NOTHING` lets exactly one insert win; the loser
 * waits for the winner's commit, inserts nothing and finds the row on its second pass — so the event and the
 * audit row are written once.
 */
async function locate(
  tx: Queryable,
  scope: CustomerScope,
  identity: CustomerIdentity,
): Promise<Located> {
  for (let pass = 0; pass < 2; pass += 1) {
    const mine = await tx.query<CustomerRow>(
      `SELECT ${COLS} FROM customer WHERE store_id = $1 AND keycloak_subject = $2`,
      [scope.storeId, identity.subject],
    );
    const existing = mine.rows[0];
    if (existing) return { row: active(existing), outcome: 'existing', changed: [] };

    if (!identity.email || !identity.email.trim()) {
      // Without an email there is nothing to create the row from (customer.email is NOT NULL).
      throw new AppError('unauthorized', 'customer token carries no email', { reason: 'no_email' });
    }
    const email = normalizeEmail(identity.email);

    // Row locks, so two requests deciding about the same email decide one after the other. A plain single-table
    // SELECT … FOR UPDATE that had to wait returns the row as committed by the other transaction.
    const taken = await tx.query<CustomerRow>(
      `SELECT ${COLS} FROM customer WHERE store_id = $1 AND lower(email) = $2
       ORDER BY created_at, id FOR UPDATE`,
      [scope.storeId, email],
    );
    if (taken.rows.length > 0) {
      const own = taken.rows.find((r) => r.keycloak_subject === identity.subject);
      if (own) return { row: active(own), outcome: 'existing', changed: [] };
      const candidate = taken.rows[0]!;
      if (taken.rows.length > 1 || !identity.emailVerified || candidate.keycloak_subject !== null) {
        throw emailTaken();
      }
      active(candidate);
      const adopted = await tx.query<CustomerRow>(
        `UPDATE customer SET keycloak_subject = $2, status = 'registered'
         WHERE id = $1 AND keycloak_subject IS NULL RETURNING ${COLS}`,
        [candidate.id, identity.subject],
      );
      const linked = adopted.rows[0];
      if (!linked) throw emailTaken();
      return {
        row: linked,
        outcome: 'adopted',
        changed: ['keycloak_subject', ...(candidate.status === 'registered' ? [] : ['status'])],
      };
    }

    const inserted = await tx.query<CustomerRow>(
      `INSERT INTO customer (organization_id, store_id, keycloak_subject, email, status)
       VALUES ($1, $2, $3, $4, 'registered')
       ON CONFLICT DO NOTHING RETURNING ${COLS}`,
      [scope.organizationId, scope.storeId, identity.subject, email],
    );
    const created = inserted.rows[0];
    if (created) return { row: created, outcome: 'created', changed: [] };
    // Lost a race: another request created this subject's row (or one with this email) — look again.
  }
  throw conflict('the customer could not be created, try again', {});
}

interface ProfilePatch {
  first_name?: string | undefined;
  last_name?: string | undefined;
  marketing_consent?: boolean | undefined;
}

/**
 * Applies names and consent to the (locked) row and returns it with the column names that changed. The consent
 * block is written only when the answer CHANGES: a `false` on a customer who was never asked records nothing, so
 * "never asked" stays distinguishable from "opted out" (the marketing module's re-consent segments rely on it).
 */
async function applyProfile(
  tx: Queryable,
  id: string,
  patch: ProfilePatch,
): Promise<{ row: CustomerRow; changed: string[] }> {
  const locked = await tx.query<CustomerRow>(
    `SELECT ${COLS} FROM customer WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const before = active(locked.rows[0]!);
  const changed: string[] = [];
  const firstName = patch.first_name === undefined ? before.first_name : patch.first_name;
  const lastName = patch.last_name === undefined ? before.last_name : patch.last_name;
  if (firstName !== before.first_name) changed.push('first_name');
  if (lastName !== before.last_name) changed.push('last_name');
  const consentChanges =
    patch.marketing_consent !== undefined &&
    patch.marketing_consent !== marketingConsent(before.consent);
  if (consentChanges) changed.push('marketing_consent');
  if (changed.length === 0) return { row: before, changed };
  const updated = await tx.query<CustomerRow>(
    `UPDATE customer
     SET first_name = $2, last_name = $3,
         consent = CASE WHEN $4::jsonb IS NULL THEN consent
                        ELSE jsonb_set(coalesce(consent, '{}'::jsonb), '{marketing_email}', $4::jsonb) END
     WHERE id = $1 RETURNING ${COLS}`,
    [
      id,
      firstName,
      lastName,
      consentChanges
        ? JSON.stringify({
            granted: patch.marketing_consent,
            at: new Date().toISOString(),
            source: CONSENT_SOURCE,
          })
        : null,
    ],
  );
  return { row: updated.rows[0]!, changed };
}

/** One audit row and one event for whatever happened to the row in this transaction — or nothing at all. */
async function record(
  tx: Queryable,
  scope: CustomerScope,
  row: CustomerRow,
  outcome: Outcome,
  changed: string[],
): Promise<void> {
  if (outcome !== 'created' && changed.length === 0) return;
  // The customer acts on their own row. Ids, status, consent and column NAMES only: no email, no name.
  const actor: Actor = { id: row.id, type: 'customer', requestId: scope.requestId ?? null };
  const facts = {
    customer_id: row.id,
    identity_id: row.identity_id,
    email_hash: customerEmailHash(row.email),
    status: row.status,
    customer_group_id: row.customer_group_id,
    marketing_consent: marketingConsent(row.consent),
  };
  await writeAudit(tx, {
    organizationId: scope.organizationId,
    storeId: scope.storeId,
    actor,
    action:
      outcome === 'created'
        ? 'customer.create'
        : outcome === 'adopted'
          ? 'customer.link'
          : 'customer.update',
    entityType: 'customer',
    entityId: row.id,
    after: {
      status: row.status,
      marketing_consent: facts.marketing_consent,
      ...(outcome === 'created' ? {} : { changed_fields: changed }),
    },
  });
  const envelope = {
    organizationId: scope.organizationId,
    storeId: scope.storeId,
    aggregateType: 'customer' as const,
    aggregateId: row.id,
    actor: eventActor(actor),
  };
  await withEvents(tx, [
    outcome === 'created'
      ? await buildEvent({ ...envelope, topic: 'customer.created', payload: facts })
      : await buildEvent({
          ...envelope,
          topic: 'customer.updated',
          payload: { ...facts, changed_fields: changed },
        }),
  ]);
}

async function resolveIn(
  tx: Queryable,
  scope: CustomerScope,
  identity: CustomerIdentity,
  patch?: ProfilePatch,
): Promise<{ row: CustomerRow; created: boolean }> {
  const located = await locate(tx, scope, identity);
  let row = located.row;
  const changed = [...located.changed];
  if (patch) {
    const applied = await applyProfile(tx, row.id, patch);
    row = applied.row;
    changed.push(...applied.changed);
  }
  await record(tx, scope, row, located.outcome, changed);
  return { row, created: located.outcome === 'created' };
}

/**
 * `GET /store/customers/me` — and the first step of every other `/me` operation: the customer of the verified
 * token in this store, created on first use (`marketing_consent` false). 401 for a disabled or erased customer
 * and for a token without an email that has no row yet; 409 when the token's email is on a row that cannot be
 * adopted.
 */
export async function resolveCustomer(
  client: ScopedClient,
  scope: CustomerScope,
  identity: CustomerIdentity,
): Promise<Customer> {
  return client.transaction(async (tx) => toCustomer((await resolveIn(tx, scope, identity)).row));
}

/**
 * `POST /store/customers`: resolve-or-provision, then apply the names and the consent. `created` tells the route
 * 201 from 200. The body's `email` must equal the token's (trimmed, case-insensitive) — it is a confirmation,
 * never an input: a mismatch is a 400 and nothing is written.
 */
export async function registerCustomer(
  client: ScopedClient,
  scope: CustomerScope,
  identity: CustomerIdentity,
  input: RegisterCustomerInput,
): Promise<{ customer: Customer; created: boolean }> {
  if (identity.email && normalizeEmail(input.email) !== normalizeEmail(identity.email)) {
    throw validationError('email must be the email of the signed-in customer', {
      email: 'must equal the email of the customer token',
    });
  }
  return client.transaction(async (tx) => {
    const { row, created } = await resolveIn(tx, scope, identity, {
      first_name: input.first_name,
      last_name: input.last_name,
      marketing_consent: input.marketing_consent,
    });
    return { customer: toCustomer(row), created };
  });
}

/**
 * Read-only lookup for routes that must NOT create a customer (`GET /store/orders/{orderId}`): the row of a
 * verified subject in this store with its status, or null.
 */
export async function findCustomerForSubject(
  client: ScopedClient,
  storeId: string,
  subject: string,
): Promise<{ id: string; status: CustomerRow['status'] } | null> {
  const r = await client.query<{ id: string; status: CustomerRow['status'] }>(
    `SELECT id, status FROM customer WHERE store_id = $1 AND keycloak_subject = $2`,
    [storeId, subject],
  );
  return r.rows[0] ?? null;
}
