// Live EasyPost round trip in TEST MODE. Skips unless EASYPOST_API_KEY is set (repo-root .env or the CI
// environment) and refuses to run against a live key. Credentials are read from the environment only.
//
// It buys a real test label (EasyPost's test mode never charges and never ships) and voids it again. The
// addresses below are EasyPost's own documentation addresses — no customer data goes to a third party from a test.
import { loadDotenv } from '@platform/db';
import { describe, expect, it } from 'vitest';
import { createEasyPostProvider } from './easypost-provider';
import { isTestModeKey } from './config';
import type { CarrierAddress } from './types';

loadDotenv();
const apiKey = process.env.EASYPOST_API_KEY;
const live = Boolean(apiKey && isTestModeKey(apiKey));

if (apiKey && !isTestModeKey(apiKey)) {
  console.warn('easypost live test skipped: EASYPOST_API_KEY is not a test-mode key (EZTK…)');
}

const from: CarrierAddress = {
  name: 'EasyPost',
  company: 'EasyPost',
  line1: '417 Montgomery Street',
  line2: '5th Floor',
  city: 'San Francisco',
  region: 'CA',
  postalCode: '94104',
  country: 'US',
  phone: '4155555555',
  email: null,
};

const to: CarrierAddress = {
  ...from,
  name: 'Dr. Steve Brule',
  company: null,
  line1: '179 N Harbor Dr',
  line2: null,
  city: 'Redondo Beach',
  region: 'CA',
  postalCode: '90277',
};

// Built inside the tests: a skipped `describe` still runs its collector, so nothing may touch the key up here.
const providerFor = () => createEasyPostProvider({ apiKey: apiKey!, timeoutMs: 30_000 });

describe.skipIf(!live)('EasyPost (live, test mode)', () => {
  it('quotes, buys and voids a label, then tracks it', async () => {
    const provider = providerFor();
    const rates = await provider.rates({
      from,
      to,
      parcels: [{ lengthCm: 25, widthCm: 20, heightCm: 10, weightG: 450 }],
      currency: 'USD',
    });
    expect(rates.length).toBeGreaterThan(0);
    for (const rate of rates) {
      expect(rate.currency).toBe('USD');
      expect(Number.isInteger(rate.priceMinor)).toBe(true);
      expect(rate.priceMinor).toBeGreaterThan(0);
    }

    const cheapest = [...rates].sort((a, b) => a.priceMinor - b.priceMinor)[0]!;
    const label = await provider.buyLabel({ rateId: cheapest.rateId, reference: 'live-test' });
    expect(label.trackingNumber).toBeTruthy();
    expect(label.labelUrl).toMatch(/^https:\/\//);
    expect(label.costMinor).toBe(cheapest.priceMinor);

    const events = await provider.track({ trackingNumber: label.trackingNumber });
    expect(Array.isArray(events)).toBe(true);

    const voided = await provider.voidLabel({ providerShipmentId: label.providerShipmentId });
    expect(typeof voided.refundStatus).toBe('string');
  }, 60_000);

  it('validates an address', async () => {
    const result = await providerFor().validateAddress!(to);
    expect(result.valid).toBe(true);
    expect(result.normalized?.country).toBe('US');
  }, 30_000);
});
