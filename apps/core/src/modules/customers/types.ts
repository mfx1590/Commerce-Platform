import type { StoreComponents } from '@platform/contracts';

/** Store API `Customer` (store-api.yaml): what the `/store/customers*` routes answer. */
export type Customer = StoreComponents['schemas']['Customer'];
/** Store API `CustomerAddress`: an `Address` with its id and the two default flags. */
export type CustomerAddress = StoreComponents['schemas']['CustomerAddress'];

/** Body of `updateMe`. An empty string clears the column (the contract has no other way to remove a phone). */
export interface CustomerPatch {
  first_name?: string | undefined;
  last_name?: string | undefined;
  phone?: string | undefined;
  marketing_consent?: boolean | undefined;
}

/**
 * Body of `addMyAddress`: the contract's `Address`, plus the two optional default flags of contracts 0.4.9
 * (built against the field names before the spec carries them). Absent flags: the customer's FIRST address is
 * the default for shipping and billing, later ones are neither. `true` makes the new row the default and
 * clears the flag on the customer's other rows; `false` leaves a LATER row without it and is ignored on the first
 * (the first address is always the default for both).
 */
export interface AddressInput {
  first_name: string;
  last_name: string;
  company?: string | null | undefined;
  line1: string;
  line2?: string | null | undefined;
  city: string;
  region?: string | null | undefined;
  postal_code: string;
  country: string;
  phone?: string | null | undefined;
  is_default_shipping?: boolean | undefined;
  is_default_billing?: boolean | undefined;
}

export interface CustomerAddressRow {
  id: string;
  customer_id: string;
  first_name: string;
  last_name: string;
  company: string | null;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postal_code: string;
  country: string;
  phone: string | null;
  is_default_shipping: boolean;
  is_default_billing: boolean;
}

/**
 * Who the request is, taken from a VERIFIED customers-realm token and from nothing else (never from a request
 * body). `emailVerified` is true only when the token's `email_verified` claim is `true`; an absent claim is false.
 */
export interface CustomerIdentity {
  /** Keycloak `sub`. */
  subject: string;
  /** The token's `email` claim. A token without one can read an existing customer but cannot create one. */
  email?: string | undefined;
  emailVerified: boolean;
}

/** The store the request acts on (from the publishable key) and the request id for the audit row. */
export interface CustomerScope {
  organizationId: string;
  storeId: string;
  requestId?: string | null;
}

/** Body of `registerCustomer`. `email` only confirms the token's email — it is never stored from here. */
export interface RegisterCustomerInput {
  email: string;
  first_name?: string;
  last_name?: string;
  marketing_consent?: boolean;
}

export type CustomerStatus = 'guest' | 'registered' | 'disabled' | 'erased';

export interface CustomerRow {
  id: string;
  organization_id: string;
  store_id: string;
  identity_id: string | null;
  keycloak_subject: string | null;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  customer_group_id: string | null;
  status: CustomerStatus;
  consent: Record<string, unknown> | null;
}
