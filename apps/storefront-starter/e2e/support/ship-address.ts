/**
 * The shipping address the checkout journey enters (#441 part 3).
 *
 * A brand ships where its store ships: brand B is GB-only and brand C US-only, and the starter's
 * Netherlands address made four inherited funnel tests fail with "No delivery options are available
 * for this address" — a correct app failing a helper that assumed brand A's market. A brand sets
 * `E2E_SHIP_ADDRESS_JSON` (its own, preserved `playwright.config.ts` is the place); the starter keeps
 * its NL address. The values are ours, not the dataset's, so they are safe to assert on.
 */

export interface ShipAddress {
  first_name: string;
  last_name: string;
  line1: string;
  postal_code: string;
  city: string;
  /** ISO 3166-1 alpha-2, as the address form takes it. */
  country: string;
}

export const DEFAULT_SHIP_ADDRESS: ShipAddress = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  line1: 'Keizersgracht 1',
  postal_code: '1015 CJ',
  city: 'Amsterdam',
  country: 'NL',
};

const FIELDS = ['first_name', 'last_name', 'line1', 'postal_code', 'city', 'country'] as const;

/** The configured address, or the starter's default; a value that cannot be used throws, naming why. */
export function shippingAddressFromEnv(
  env: Record<string, string | undefined> = process.env,
): ShipAddress {
  const raw = env.E2E_SHIP_ADDRESS_JSON;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SHIP_ADDRESS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('E2E_SHIP_ADDRESS_JSON is not valid JSON.');
  }
  const value = (parsed ?? {}) as Record<string, unknown>;
  const missing = FIELDS.filter(
    (field) => typeof value[field] !== 'string' || (value[field] as string).trim() === '',
  );
  if (missing.length > 0) {
    throw new Error(`E2E_SHIP_ADDRESS_JSON is missing ${missing.join(', ')}.`);
  }
  if (!/^[A-Z]{2}$/.test(value.country as string)) {
    throw new Error('E2E_SHIP_ADDRESS_JSON: country must be a two-letter code such as "GB".');
  }
  return Object.fromEntries(FIELDS.map((field) => [field, value[field]])) as unknown as ShipAddress;
}
