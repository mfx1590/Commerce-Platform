// Consent API over the ledger (#471, Store API 0.5.7 `getMyConsents` / `putMyConsents`, Admin API 0.4.18
// `listCustomerConsents`). The Store side resolves the customer from the token exactly like every other `/me`
// operation (`resolveIn`: locked row, status judged after any concurrent erase); the Admin side runs on the
// store-scoped client the router hands in, so a brand-b support reading a brand-a customer gets the same 404 as
// an unknown id.
import type { ScopedClient } from '@platform/db';
import type { StoreComponents } from '@platform/contracts';
import { AppError, validationError } from '../../lib/errors';
import {
  CONSENT_PURPOSES,
  consentLedger,
  latestDecisions,
  recordConsent,
  type ConsentDecision,
  type ConsentPurpose,
} from './consent-ledger';
import { record, resolveIn } from './service';
import type { CustomerIdentity, CustomerScope } from './types';

/** Store API `CustomerConsent`: one per purpose of the closed set; `granted: null` = never asked. */
export type CustomerConsent = StoreComponents['schemas']['CustomerConsent'];

/** Body of `putMyConsents`. */
export interface PutMyConsentsInput {
  policy_version: string;
  consents: Array<{ purpose: string; granted: boolean }>;
}

function currentState(latest: Map<ConsentPurpose, ConsentDecision>): CustomerConsent[] {
  return CONSENT_PURPOSES.map((purpose) => {
    const d = latest.get(purpose);
    return d
      ? {
          purpose,
          granted: d.granted,
          source: d.source,
          policy_version: d.policy_version,
          recorded_at: d.recorded_at,
        }
      : { purpose, granted: null, source: null, policy_version: null, recorded_at: null };
  });
}

/** `GET /store/customers/me/consents`. */
export async function getMyConsents(
  client: ScopedClient,
  scope: CustomerScope,
  identity: CustomerIdentity,
): Promise<CustomerConsent[]> {
  return client.transaction(async (tx) => {
    const { row } = await resolveIn(tx, scope, identity);
    return currentState(await latestDecisions(tx, row.id));
  });
}

/**
 * `PUT /store/customers/me/consents`: validates (a blank `policy_version`, an empty list, an unknown purpose or a
 * purpose given twice is a 400 naming the field), then records each answer through `recordConsent`. Whatever
 * changed yields ONE `customer.updated` (`changed_fields: ['marketing_consent']` — the projection's name, as
 * `updateMe` reports it) and one audit row; an unchanged answer writes nothing at all.
 */
export async function putMyConsents(
  client: ScopedClient,
  scope: CustomerScope,
  identity: CustomerIdentity,
  input: PutMyConsentsInput,
): Promise<CustomerConsent[]> {
  const problems: Record<string, string> = {};
  const policyVersion = typeof input.policy_version === 'string' ? input.policy_version.trim() : '';
  if (policyVersion === '') problems.policy_version = 'required';
  if (policyVersion.length > 100) problems.policy_version = 'at most 100 characters';
  const answers: Array<{ purpose: ConsentPurpose; granted: boolean }> = [];
  if (!Array.isArray(input.consents) || input.consents.length === 0) {
    problems.consents = 'at least one';
  } else {
    input.consents.forEach((c, i) => {
      const purpose = c?.purpose as ConsentPurpose;
      if (!CONSENT_PURPOSES.includes(purpose)) {
        problems[`consents.${i}.purpose`] = `one of ${CONSENT_PURPOSES.join(', ')}`;
      } else if (answers.some((a) => a.purpose === purpose)) {
        problems[`consents.${i}.purpose`] = 'given twice';
      }
      if (typeof c?.granted !== 'boolean') problems[`consents.${i}.granted`] = 'boolean';
      if (!problems[`consents.${i}.purpose`] && !problems[`consents.${i}.granted`]) {
        answers.push({ purpose, granted: c.granted });
      }
    });
  }
  if (Object.keys(problems).length) throw validationError('invalid consents', problems);

  return client.transaction(async (tx) => {
    let { row } = await resolveIn(tx, scope, identity);
    let changed = false;
    for (const a of answers) {
      const r = await recordConsent(tx, scope, row, {
        purpose: a.purpose,
        granted: a.granted,
        source: 'storefront',
        policyVersion,
      });
      row = r.row;
      changed = changed || r.changed;
    }
    if (changed) await record(tx, scope, row, 'existing', ['marketing_consent']);
    return currentState(await latestDecisions(tx, row.id));
  });
}

/**
 * Admin API `listCustomerConsents` (support on the store): the ledger, newest first, optionally one purpose.
 * 404 for an unknown customer, another store's (invisible under RLS) and an erased one (its ledger is gone).
 */
export async function adminListCustomerConsents(
  client: ScopedClient,
  storeId: string,
  customerId: string,
  purpose?: ConsentPurpose,
): Promise<ConsentDecision[]> {
  const r = await client.query<{ status: string }>(
    'SELECT status FROM customer WHERE id = $1 AND store_id = $2',
    [customerId, storeId],
  );
  if (!r.rows[0] || r.rows[0].status === 'erased') {
    throw new AppError('not_found', 'customer not found', { customer_id: customerId });
  }
  return consentLedger(client, customerId, purpose);
}
