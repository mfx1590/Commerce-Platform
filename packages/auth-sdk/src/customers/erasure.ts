// Delete the customers-realm Keycloak user after a customer erasure (issue #483, window 13's REQUEST for #470).
//
// After `eraseCustomer` / `deleteMe` the Postgres row holds no personal data, but the Keycloak user (email, names,
// credentials) still exists. The erased row keeps `keycloak_subject` as the erasure TOMBSTONE — an opaque IdP id,
// never logged. One customers realm serves every brand, so the same subject may still own a LIVE (non-erased)
// row in another store of the organization (per-brand accounts; cross-brand self-service deletion is still the
// owner's open decision): the user is deleted only when no live row of the organization carries the subject —
// read through an ORGANIZATION-scope client, never a store-scoped one. Idempotent by state: a replayed event
// finds the user already gone (404 = done) or nothing to delete. The consumer that calls this on
// `customer.erased` lives outside this package (a core job / window 14's relay); `onCustomerErased` is the
// bus-side entry.
import type { ScopedClient } from '@platform/db';
import { audit, type AuditActorType } from '../audit/write.js';
import type { KeycloakAdmin } from '../keycloak/admin.js';
import { ApiError } from '../types.js';

export interface CustomerErasureDeps {
  /** ORGANIZATION-scope client (`createOrganizationClient`): the live-row check spans every store. */
  db: ScopedClient;
  /** Service-account client for the CUSTOMERS realm (`createKeycloakAdmin({ realm: 'customers', … })`). */
  keycloak: Pick<KeycloakAdmin, 'deleteUser' | 'realm'>;
  requestId?: string | null;
}

export type CustomerErasureOutcome =
  /** No row, not erased, or a guest row without a subject: nothing to delete. */
  | 'nothing_to_delete'
  /** A non-erased row of the organization still carries the subject: the Keycloak user stays. */
  | 'kept_live_elsewhere'
  /** Keycloak deleted the user now. */
  | 'deleted'
  /** Keycloak had no such user any more (a replay, or deleted by other means). */
  | 'already_gone';

export interface CustomerErasureResult {
  customerId: string;
  outcome: CustomerErasureOutcome;
  /** Non-erased rows of the organization that still carry the subject (0 unless kept). */
  liveRows: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorOf(db: ScopedClient): { id: string | null; type: AuditActorType } {
  const id = db.context.actorId ?? null;
  return { id, type: id ? 'staff' : 'system' };
}

/**
 * Deletes the customers-realm user of an ERASED customer row unless a live row of the organization still uses
 * the same subject. Never logs or returns the subject; writes one `customer.identity_deleted` audit row with ids
 * and the outcome only (no row for `nothing_to_delete`). Keycloak unreachable → 503 (fail closed, retry later).
 */
export async function deleteErasedCustomerIdentity(
  deps: CustomerErasureDeps,
  input: { customerId: string },
): Promise<CustomerErasureResult> {
  const { customerId } = input;
  if (!UUID.test(customerId)) {
    throw new ApiError(400, 'validation_error', 'customerId must be a uuid', {
      field: 'customerId',
    });
  }
  if (deps.keycloak.realm !== 'customers') {
    throw new ApiError(500, 'internal', 'the customers-realm admin client is required', {
      realm: deps.keycloak.realm,
    });
  }
  const { db } = deps;
  const row = await db.query<{ status: string; keycloak_subject: string | null; store_id: string }>(
    'SELECT status, keycloak_subject, store_id FROM customer WHERE id = $1',
    [customerId],
  );
  const r = row.rows[0];
  if (!r || r.status !== 'erased' || !r.keycloak_subject) {
    return { customerId, outcome: 'nothing_to_delete', liveRows: 0 };
  }
  const subject = r.keycloak_subject;
  const live = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM customer
     WHERE keycloak_subject = $1 AND status <> 'erased' AND id <> $2`,
    [subject, customerId],
  );
  const liveRows = Number(live.rows[0]!.n);
  let outcome: CustomerErasureOutcome;
  if (liveRows > 0) {
    outcome = 'kept_live_elsewhere';
  } else {
    // 404 is tolerated by the client: the replayed event and the already-deleted user end here as well.
    // Distinguish them so the audit trail says what actually happened.
    outcome = (await deps.keycloak.deleteUser(subject)) === 'deleted' ? 'deleted' : 'already_gone';
  }
  await db.transaction(async (tx) => {
    await audit(tx, {
      action: 'customer.identity_deleted',
      entityType: 'customer',
      entityId: customerId,
      before: null,
      after: { outcome, live_rows: liveRows, realm: deps.keycloak.realm },
      storeId: r.store_id,
      actor: actorOf(db),
      requestId: deps.requestId ?? null,
    });
  });
  return { customerId, outcome, liveRows };
}

/** The envelope fields this consumer reads (packages/events `customer.erased` v1). */
export interface CustomerErasedEnvelope {
  event_id: string;
  topic: string;
  version: number;
  organization_id: string;
  payload: { customer_id: string };
}

export type CustomerErasedEventResult =
  | { handled: true; result: CustomerErasureResult }
  | { handled: false; reason: 'wrong_topic' | 'unsupported_version' | 'wrong_organization' };

/**
 * Bus-side entry for a `customer.erased` v1 event: ignores other topics/versions and events of another
 * organization (typed result, never a throw), otherwise runs `deleteErasedCustomerIdentity`. Idempotent per
 * event by construction, so no event_id store is needed.
 */
export async function onCustomerErased(
  deps: CustomerErasureDeps,
  envelope: CustomerErasedEnvelope,
): Promise<CustomerErasedEventResult> {
  if (envelope.topic !== 'customer.erased') return { handled: false, reason: 'wrong_topic' };
  if (envelope.version !== 1) return { handled: false, reason: 'unsupported_version' };
  if (envelope.organization_id !== deps.db.context.organizationId) {
    return { handled: false, reason: 'wrong_organization' };
  }
  const result = await deleteErasedCustomerIdentity(deps, {
    customerId: envelope.payload.customer_id,
  });
  return { handled: true, result };
}
