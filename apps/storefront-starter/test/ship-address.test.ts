import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHIP_ADDRESS,
  MOCK_CART_LINE1,
  reviewAddressLine1,
  shippingAddressFromEnv,
} from '../e2e/support/ship-address';

/**
 * #441 part 3: the funnel's shipping address comes from the brand (`E2E_SHIP_ADDRESS_JSON`), with
 * the starter's Netherlands address as the default — a GB- or US-only brand failed four inherited
 * funnel tests with "No delivery options are available for this address".
 */
describe('shippingAddressFromEnv', () => {
  it('is the starter’s NL address when nothing is set', () => {
    expect(shippingAddressFromEnv({})).toEqual(DEFAULT_SHIP_ADDRESS);
    expect(DEFAULT_SHIP_ADDRESS).toMatchObject({ country: 'NL', postal_code: '1015 CJ' });
    expect(shippingAddressFromEnv({ E2E_SHIP_ADDRESS_JSON: ' ' })).toEqual(DEFAULT_SHIP_ADDRESS);
  });

  it('takes a brand’s address from E2E_SHIP_ADDRESS_JSON', () => {
    const gb = {
      first_name: 'Ada',
      last_name: 'Lovelace',
      line1: '10 Downing Street',
      postal_code: 'SW1A 2AA',
      city: 'London',
      country: 'GB',
    };
    expect(shippingAddressFromEnv({ E2E_SHIP_ADDRESS_JSON: JSON.stringify(gb) })).toEqual(gb);
  });

  it('refuses a value it cannot use, naming what is wrong', () => {
    expect(() => shippingAddressFromEnv({ E2E_SHIP_ADDRESS_JSON: '{not json' })).toThrow(
      /E2E_SHIP_ADDRESS_JSON is not valid JSON/,
    );
    expect(() =>
      shippingAddressFromEnv({ E2E_SHIP_ADDRESS_JSON: JSON.stringify({ country: 'GB' }) }),
    ).toThrow(/missing first_name, last_name, line1, postal_code, city/);
    expect(() =>
      shippingAddressFromEnv({
        E2E_SHIP_ADDRESS_JSON: JSON.stringify({ ...DEFAULT_SHIP_ADDRESS, country: 'Britain' }),
      }),
    ).toThrow(/country must be a two-letter code/);
  });
});

describe('reviewAddressLine1 (#449)', () => {
  const GB = JSON.stringify({
    first_name: 'Ada',
    last_name: 'Lovelace',
    line1: '10 Downing Street',
    postal_code: 'SW1A 2AA',
    city: 'London',
    country: 'GB',
  });

  it('is the configured street when the journey typed the address — the brand’s, not the NL default', () => {
    expect(reviewAddressLine1(true, { E2E_SHIP_ADDRESS_JSON: GB })).toBe('10 Downing Street');
    expect(reviewAddressLine1(true, {})).toBe(DEFAULT_SHIP_ADDRESS.line1);
  });

  it('is the contract example cart’s street when the backend already had one (the mock)', () => {
    expect(reviewAddressLine1(false, { E2E_SHIP_ADDRESS_JSON: GB })).toBe(MOCK_CART_LINE1);
  });
});
