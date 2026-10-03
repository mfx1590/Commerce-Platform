import type { StoreComponents } from '@platform/contracts';

/** Store API `Customer` (store-api.yaml): what the `/store/customers*` routes answer. */
export type Customer = StoreComponents['schemas']['Customer'];

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
