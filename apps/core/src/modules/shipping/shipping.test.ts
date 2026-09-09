// Credentials, per-store configuration, minor-unit conversion, address redaction and the provider registry.
import { afterEach, describe, expect, it } from 'vitest';
import {
  carrierConfigFor,
  DEFAULT_PARCEL,
  easyPostCredentialsFor,
  envSuffix,
  isTestModeKey,
} from './config';
import { createManualCarrierProvider, manualCarrierProvider } from './manual-provider';
import { currencyExponent, fromMinorUnits, toMinorUnits } from './money';
import { CarrierError, isRetryableStatus, redactAddress, toCarrierAddress } from './redact';
import {
  carrierProvider,
  carrierProviderOrManual,
  registeredCarrierProviders,
  resetCarrierProviders,
  setCarrierProvider,
} from './registry';
import type { ContractAddress } from './types';

describe('carrier credentials (ADR 0006)', () => {
  it('prefers the store variable over the global one and reports which supplied it', () => {
    const env = { EASYPOST_API_KEY: 'EZTKglobal', EASYPOST_API_KEY_BRAND_A: 'EZTKstore' };
    expect(easyPostCredentialsFor('brand-a', env)).toEqual({
      apiKey: 'EZTKstore',
      source: 'store',
      variable: 'EASYPOST_API_KEY_BRAND_A',
    });
    expect(easyPostCredentialsFor('brand-b', env)).toEqual({
      apiKey: 'EZTKglobal',
      source: 'global',
      variable: 'EASYPOST_API_KEY',
    });
    expect(easyPostCredentialsFor('brand-a', {})).toBeNull();
  });

  it('derives the variable suffix from the store code', () => {
    expect(envSuffix('brand-a')).toBe('BRAND_A');
    expect(envSuffix('brand.c 2')).toBe('BRAND_C_2');
  });

  it('recognises a test-mode key', () => {
    expect(isTestModeKey('EZTK123')).toBe(true);
    expect(isTestModeKey('EZAK123')).toBe(false);
  });
});

describe('per-store carrier configuration', () => {
  it('defaults to the manual provider when a store has no shipping settings', () => {
    for (const settings of [undefined, null, {}, { shipping: 'nonsense' }, { shipping: [] }]) {
      expect(carrierConfigFor(settings)).toEqual({
        provider: 'manual',
        carrierAccountIds: [],
        services: [],
        defaultParcel: DEFAULT_PARCEL,
        labelFormat: 'pdf',
      });
    }
  });

  it('reads the documented shape', () => {
    expect(
      carrierConfigFor({
        shipping: {
          provider: 'easypost',
          carrier_account_ids: ['ca_1', ' ca_2 ', '', 7],
          services: ['UPSGround'],
          default_parcel: { length_cm: 40, width_cm: 30, height_cm: 20, weight_g: 2500 },
          label_format: 'ZPL',
        },
      }),
    ).toEqual({
      provider: 'easypost',
      carrierAccountIds: ['ca_1', 'ca_2'],
      services: ['UPSGround'],
      defaultParcel: { lengthCm: 40, widthCm: 30, heightCm: 20, weightG: 2500 },
      labelFormat: 'zpl',
    });
  });

  it('falls back per field rather than throwing on a mistyped setting', () => {
    const config = carrierConfigFor({
      shipping: {
        provider: '  ',
        default_parcel: { length_cm: 0, width_cm: 30, height_cm: 20, weight_g: 2500 },
        label_format: 'tiff',
        services: 'UPSGround',
      },
    });
    expect(config).toEqual({
      provider: 'manual',
      carrierAccountIds: [],
      services: [],
      defaultParcel: DEFAULT_PARCEL,
      labelFormat: 'pdf',
    });
  });
});

describe('minor units', () => {
  it('converts decimal strings without touching a float', () => {
    expect(toMinorUnits('12.34', 'EUR')).toBe(1234);
    expect(toMinorUnits('12.4', 'EUR')).toBe(1240);
    expect(toMinorUnits('12', 'EUR')).toBe(1200);
    expect(toMinorUnits(0.1 + 0.2, 'EUR')).toBe(30);
    expect(toMinorUnits('-3.50', 'USD')).toBe(-350);
  });

  it('rounds half away from zero at the currency exponent', () => {
    expect(toMinorUnits('8.005', 'EUR')).toBe(801);
    expect(toMinorUnits('8.004', 'EUR')).toBe(800);
    expect(toMinorUnits('1250.6', 'JPY')).toBe(1251);
    expect(toMinorUnits('1.23456', 'KWD')).toBe(1235);
  });

  it('knows the currencies whose minor unit is not 1/100', () => {
    expect(currencyExponent('jpy')).toBe(0);
    expect(currencyExponent('TND')).toBe(3);
    expect(currencyExponent('EUR')).toBe(2);
  });

  it('round-trips back to a decimal string', () => {
    expect(fromMinorUnits(1234, 'EUR')).toBe('12.34');
    expect(fromMinorUnits(7, 'EUR')).toBe('0.07');
    expect(fromMinorUnits(-350, 'USD')).toBe('-3.50');
    expect(fromMinorUnits(1251, 'JPY')).toBe('1251');
    expect(fromMinorUnits(1235, 'KWD')).toBe('1.235');
  });

  it('refuses anything that is not a decimal amount', () => {
    for (const bad of ['', 'free', '1.2.3', '1e3', ' 12,34 ']) {
      expect(() => toMinorUnits(bad, 'EUR')).toThrow(RangeError);
    }
  });
});

describe('addresses', () => {
  const contract: ContractAddress = {
    first_name: 'Ada',
    last_name: 'Lovelace',
    company: null,
    line1: '12 Rue de la Paix',
    line2: 'Apt 4',
    city: 'Paris',
    region: 'IDF',
    postal_code: '75002',
    country: 'fr',
    phone: '+33100000000',
  };

  it('converts a contract address into the carrier shape', () => {
    expect(toCarrierAddress(contract, { email: 'ada@example.com' })).toEqual({
      name: 'Ada Lovelace',
      company: null,
      line1: '12 Rue de la Paix',
      line2: 'Apt 4',
      city: 'Paris',
      region: 'IDF',
      postalCode: '75002',
      country: 'FR',
      phone: '+33100000000',
      email: 'ada@example.com',
    });
    expect(toCarrierAddress(contract).email).toBeNull();
  });

  it('redacts to a routing zone: no name, street, city, phone or full postal code', () => {
    const redacted = redactAddress(toCarrierAddress(contract));
    expect(redacted).toEqual({ country: 'FR', region: 'IDF', postal_prefix: '75' });
    const serialised = JSON.stringify(redacted);
    for (const secret of ['Ada', 'Lovelace', 'Rue de la Paix', 'Paris', '75002', '+33']) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('handles an empty postal code', () => {
    const redacted = redactAddress({ ...toCarrierAddress(contract), postalCode: '  ' });
    expect(redacted.postal_prefix).toBeNull();
  });
});

describe('CarrierError', () => {
  it('names the provider, operation and status without a payload', () => {
    const error = new CarrierError('easypost', 429, 'rates', 'rate limited', true);
    expect(error.message).toBe('easypost rates failed (429): rate limited');
    expect(error.retryable).toBe(true);
  });

  it('classifies which statuses are worth falling back on', () => {
    expect([0, 408, 429, 500, 503].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 404, 422].some(isRetryableStatus)).toBe(false);
  });
});

describe('provider registry', () => {
  afterEach(() => resetCarrierProviders());

  it('serves the built-in manual provider', () => {
    expect(registeredCarrierProviders()).toEqual(['manual']);
    expect(carrierProvider('manual')).toBe(manualCarrierProvider);
    expect(carrierProvider('easypost')).toBeUndefined();
  });

  it('registers a provider at boot and returns the one it replaced', () => {
    const stub = createManualCarrierProvider(undefined, 'easypost');
    expect(setCarrierProvider(stub)).toBeUndefined();
    expect(carrierProvider('easypost')).toBe(stub);
    const replacement = createManualCarrierProvider(undefined, 'easypost');
    expect(setCarrierProvider(replacement)).toBe(stub);
    expect(registeredCarrierProviders()).toEqual(['manual', 'easypost']);
  });

  it('falls back to manual for an unknown or unset provider name', () => {
    expect(carrierProviderOrManual('easypost')).toBe(manualCarrierProvider);
    expect(carrierProviderOrManual(null)).toBe(manualCarrierProvider);
    expect(carrierProviderOrManual(undefined)).toBe(manualCarrierProvider);
  });

  it('resets back to the built-in provider', () => {
    setCarrierProvider(createManualCarrierProvider(undefined, 'easypost'));
    resetCarrierProviders();
    expect(registeredCarrierProviders()).toEqual(['manual']);
  });
});
