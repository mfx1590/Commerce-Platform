// What the CRM side deals in (#555).
//
// PII RULE, and it differs from every other module here: a CRM contact needs a name and an e-mail, so this is
// the one place in the service that handles personal data at all. The rules that follow from that:
//
//   * it is fetched from the core Admin API with this service's own principal (#565), never from an event;
//   * it lives in a `CrmContact` on its way to the adapter and is never written to a log line, an error
//     message, a database row of ours or a dead letter;
//   * the upsert key is OUR `customer_id` in the CRM's external-id field, NEVER the e-mail (#555). An e-mail
//     changes, two people share one, and a match on it merges two strangers' purchase histories;
//   * `customer.erased` deletes the contact.

/** The identity and the PII of one contact, as the CRM receives it. */
export interface CrmContact {
  /** Our `customer.id` — the upsert key, written to the CRM's external-id field. */
  externalId: string;
  /** The store this contact belongs to: a customer is per store (0194's rule for consent holds here too). */
  storeCode: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  /** The order/LTV numbers from `computeRollup`, flattened for the CRM's own fields. */
  ordersCount: number;
  netRevenueMinor: number;
  currency: string;
  lastOrderAt: string | null;
}

/**
 * Where contacts go. `upsert` is keyed on `externalId` and must create or update as needed; `remove` is the
 * erasure path and must be idempotent (a contact already gone is a success, not an error).
 */
export interface CrmAdapter {
  readonly name: string;
  upsert(contact: CrmContact): Promise<void>;
  /** Delete by our customer id. Idempotent: no contact for that id is a no-op, never a throw. */
  remove(externalId: string): Promise<void>;
}

/** A CRM refused a call. The provider, the status and its error name — never the body, never the contact. */
export class CrmError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'CrmError';
    this.retryable = opts.retryable ?? false;
  }
}

/**
 * How the Admin API call is authenticated. Injected so #555 can be built, tested and merged before the
 * `crm-sync` service account exists (#565): a mock returns a fixed token, and the real one will exchange the
 * client credentials for one. The provider owns any caching — nothing here stores a token.
 */
export interface TokenProvider {
  readonly name: string;
  /** A bearer token for the core Admin API, with `aud: core-api`. */
  token(): Promise<string>;
}

/** The PII this service reads, as the Admin API's `Customer` schema returns it (only the fields we use). */
export interface AdminCustomer {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: 'guest' | 'registered' | 'disabled' | 'erased';
}
