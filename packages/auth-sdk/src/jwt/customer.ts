// Customer JWT verification (ADR 0002 §8): customers-realm JWKS, and the token is bound to ONE store via the
// store_code claim each storefront client stamps (infra/keycloak/customers-realm.json).
import { ApiError } from '../types.js';
import { createStaffTokenVerifier, type StaffTokenVerifier } from './verify.js';

export interface CustomerClaims {
  /** Keycloak `sub` → `customer_identity.keycloak_subject`. */
  subject: string;
  /** The store the token is bound to (`store.code`, e.g. `brand-a`). */
  storeCode: string;
  email?: string;
  /**
   * True ONLY when the token's `email_verified` claim is the boolean `true`. Absent, null, the string
   * "true" or anything else is false. `email` is identity only when this is true: the customers realm
   * allows self-registration, so an unverified address may belong to someone else (#307).
   */
  emailVerified: boolean;
  issuer: string;
  expiresAt: number;
}

export interface CustomerTokenVerifierOptions {
  keycloakUrl?: string;
  /** `KEYCLOAK_REALM_CUSTOMERS`, default `customers`. */
  realm?: string;
  audience?: string;
  /** Override the JWKS URL (tests). */
  jwksUri?: string;
}

export interface CustomerTokenVerifier {
  readonly issuer: string;
  /**
   * Verifies the token and its store binding. `expectedStoreCode` is the store the REQUEST is for
   * (`store.code`, resolved by the core from the publishable key / host); a token stamped for another
   * store is a 401 — customers never cross stores (ADR 0002 §8).
   */
  verify(
    tokenOrHeader: string | undefined | null,
    expectedStoreCode: string,
  ): Promise<CustomerClaims>;
}

export function createCustomerTokenVerifier(
  opts: CustomerTokenVerifierOptions = {},
): CustomerTokenVerifier {
  const inner: StaffTokenVerifier = createStaffTokenVerifier({
    ...(opts.keycloakUrl ? { keycloakUrl: opts.keycloakUrl } : {}),
    realm: opts.realm ?? process.env.KEYCLOAK_REALM_CUSTOMERS ?? 'customers',
    ...(opts.audience ? { audience: opts.audience } : {}),
    ...(opts.jwksUri ? { jwksUri: opts.jwksUri } : {}),
  });
  return {
    issuer: inner.issuer,
    async verify(tokenOrHeader, expectedStoreCode) {
      const claims = await inner.verify(tokenOrHeader);
      const storeCode = claims.raw.store_code;
      if (typeof storeCode !== 'string' || storeCode.length === 0) {
        throw new ApiError(401, 'unauthorized', 'Invalid bearer token', {
          reason: 'no_store_code',
        });
      }
      if (storeCode !== expectedStoreCode) {
        // The token is valid but for another brand's storefront: unauthorized for THIS store.
        throw new ApiError(401, 'unauthorized', 'Token is bound to another store', {
          reason: 'store_mismatch',
        });
      }
      return {
        subject: claims.subject,
        storeCode,
        ...(claims.email ? { email: claims.email } : {}),
        // Strict on purpose: no truthiness, no "true" string — a lenient read here is an account takeover.
        emailVerified: claims.raw.email_verified === true,
        issuer: claims.issuer,
        expiresAt: claims.expiresAt,
      };
    },
  };
}
