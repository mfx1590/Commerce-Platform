// Address handling. Two rules from the project brief, enforced here so no call site has to remember them:
// an address never reaches a log or an event, and a carrier error never carries the payload that produced it.
import type { CarrierAddress, ContractAddress } from './types';

/** Converts a contract `Address` (first/last name) into the single-`name` shape carriers take. */
export function toCarrierAddress(
  address: ContractAddress,
  extra: { email?: string | null } = {},
): CarrierAddress {
  const name = `${address.first_name} ${address.last_name}`.trim();
  return {
    name,
    company: address.company ?? null,
    line1: address.line1,
    line2: address.line2 ?? null,
    city: address.city,
    region: address.region ?? null,
    postalCode: address.postal_code,
    country: address.country.toUpperCase(),
    phone: address.phone ?? null,
    email: extra.email ?? null,
  };
}

/**
 * What may be written to a log, an event payload or a support note: country, region and the first two characters
 * of the postal code (a routing zone, not a household). Everything identifying is dropped, not masked, so no
 * later change can accidentally widen it.
 */
export function redactAddress(address: CarrierAddress): {
  country: string;
  region: string | null;
  postal_prefix: string | null;
} {
  const prefix = address.postalCode.replace(/\s+/g, '').slice(0, 2);
  return {
    country: address.country,
    region: address.region,
    postal_prefix: prefix === '' ? null : prefix,
  };
}

/**
 * The one error a `CarrierProvider` throws. Carries the provider, the HTTP status (0 when the call never got a
 * response) and the provider's own message — never a request body, so an address cannot leak through a stack
 * trace that is logged upstream.
 */
export class CarrierError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly operation: string,
    message: string,
    /** True when a retry with the same input could succeed (network, 429, 5xx) — task 2.2 falls back on these. */
    readonly retryable = false,
  ) {
    super(`${provider} ${operation} failed (${status}): ${message}`);
    this.name = 'CarrierError';
  }
}

/** 0 (no response), 408, 429 and 5xx are worth retrying or falling back on; everything else is our mistake. */
export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}
