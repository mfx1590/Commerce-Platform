// The consent ledger (#471, db 0194 `customer_consent`, CONTRACT CHANGE #489): the record of truth for a customer's
// consent decisions in ONE store — append-only (the app role cannot UPDATE), one row per decision that CHANGED the
// answer, with the source and the privacy-policy version the customer saw. `customer.consent[purpose] = { granted,
// at, source }` stays the current-state projection that window 17's segments read, rewritten from the newest ledger
// row in the same transaction. Never-asked = no ledger row and no projection key — distinct from a refusal
// (`granted: false`), which IS recorded (manager decision 2026-10-18; it changes #303's "a first false records
// nothing" rule). Purposes are a closed set: `marketing_email` until the lawyer review (a contract change).
//
// This file has no import from service.ts so the service can call `recordConsent` without a cycle; the API-level
// functions (`getMyConsents`, `putMyConsents`, the admin read) live in consent.ts.
import type { Queryable } from '@platform/db';
import { CUSTOMER_COLS, type CustomerRow, type CustomerScope } from './types';

export const CONSENT_PURPOSES = ['marketing_email'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export const CONSENT_SOURCES = ['storefront', 'admin', 'import'] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/** What the core records when a store has not set `settings.privacy.policy_version` (#489 Q1). */
export const DEFAULT_POLICY_VERSION = 'unversioned';

/** One ledger row (Admin API `listCustomerConsents` item; `recorded_at` as an ISO string). */
export interface ConsentDecision {
  id: string;
  purpose: ConsentPurpose;
  granted: boolean;
  source: ConsentSource;
  policy_version: string;
  recorded_at: string;
}

interface LedgerRow {
  id: string;
  purpose: ConsentPurpose;
  granted: boolean;
  source: ConsentSource;
  policy_version: string;
  recorded_at: Date;
}

const toDecision = (r: LedgerRow): ConsentDecision => ({
  id: r.id,
  purpose: r.purpose,
  granted: r.granted,
  source: r.source,
  policy_version: r.policy_version,
  recorded_at: r.recorded_at.toISOString(),
});

/**
 * The store's current privacy-policy version: `store.settings.privacy.policy_version` (free-form settings, read
 * with a forgiving fallback like every other key the core reads), `unversioned` when unset or blank. Recorded with
 * the one-checkbox shortcut (`registerCustomer` / `updateMe.marketing_consent`), which carries no version of its
 * own; `putMyConsents` records the version the client displayed instead.
 */
export async function storePolicyVersion(tx: Queryable, storeId: string): Promise<string> {
  const r = await tx.query<{ v: string | null }>(
    `SELECT settings #>> '{privacy,policy_version}' AS v FROM store WHERE id = $1`,
    [storeId],
  );
  const v = r.rows[0]?.v;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : DEFAULT_POLICY_VERSION;
}

/** The newest ledger row per purpose for one customer (none for a purpose never decided). */
export async function latestDecisions(
  tx: Queryable,
  customerId: string,
): Promise<Map<ConsentPurpose, ConsentDecision>> {
  const r = await tx.query<LedgerRow>(
    `SELECT DISTINCT ON (purpose) id, purpose, granted, source, policy_version, recorded_at
     FROM customer_consent WHERE customer_id = $1
     ORDER BY purpose, recorded_at DESC, id DESC`,
    [customerId],
  );
  return new Map(r.rows.map((row) => [row.purpose, toDecision(row)]));
}

/** The whole ledger of one customer, newest first (Admin API `listCustomerConsents`; the export bundle reverses it). */
export async function consentLedger(
  tx: Queryable,
  customerId: string,
  purpose?: ConsentPurpose,
): Promise<ConsentDecision[]> {
  const r = await tx.query<LedgerRow>(
    `SELECT id, purpose, granted, source, policy_version, recorded_at FROM customer_consent
     WHERE customer_id = $1 AND ($2::text IS NULL OR purpose = $2)
     ORDER BY recorded_at DESC, id DESC`,
    [customerId, purpose ?? null],
  );
  return r.rows.map(toDecision);
}

export interface ConsentAnswer {
  purpose: ConsentPurpose;
  granted: boolean;
  source: ConsentSource;
  policyVersion: string;
}

/**
 * THE one writer of the ledger and the projection. Compares the answer with the newest ledger row for the purpose:
 * the same answer writes nothing (`changed: false`); otherwise one ledger row is inserted and the projection block
 * `{ granted, at, source }` is rewritten with the row's own `recorded_at`, in the caller's transaction, under the
 * customer-row lock the caller holds (`resolveIn`). Returns the customer row as it is afterwards. Neither the
 * ledger nor the projection carries anything personal.
 */
export async function recordConsent(
  tx: Queryable,
  scope: CustomerScope,
  row: CustomerRow,
  answer: ConsentAnswer,
): Promise<{ changed: boolean; row: CustomerRow }> {
  const latest = await tx.query<{ granted: boolean }>(
    `SELECT granted FROM customer_consent WHERE customer_id = $1 AND purpose = $2
     ORDER BY recorded_at DESC, id DESC LIMIT 1`,
    [row.id, answer.purpose],
  );
  if (latest.rows[0] && latest.rows[0].granted === answer.granted) return { changed: false, row };
  const inserted = await tx.query<{ recorded_at: Date }>(
    `INSERT INTO customer_consent (organization_id, store_id, customer_id, purpose, granted, source, policy_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING recorded_at`,
    [
      scope.organizationId,
      scope.storeId,
      row.id,
      answer.purpose,
      answer.granted,
      answer.source,
      answer.policyVersion,
    ],
  );
  const block = JSON.stringify({
    granted: answer.granted,
    at: inserted.rows[0]!.recorded_at.toISOString(),
    source: answer.source,
  });
  const updated = await tx.query<CustomerRow>(
    `UPDATE customer
     SET consent = jsonb_set(coalesce(consent, '{}'::jsonb), $2::text[], $3::jsonb), updated_at = now()
     WHERE id = $1 RETURNING ${CUSTOMER_COLS}`,
    [row.id, [answer.purpose], block],
  );
  return { changed: true, row: updated.rows[0]! };
}
