// The manual carrier: rates are a pure function of the input (asserted on exact numbers and ids), labels are
// idempotent per shipment, and voiding after a movement is refused.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createManualCarrierProvider,
  DEFAULT_MANUAL_CONFIG,
  manualCarrierProvider,
} from './manual-provider';
import { CarrierError } from './redact';
import type { CarrierAddress, RateRequest } from './types';

const address = (over: Partial<CarrierAddress> = {}): CarrierAddress => ({
  name: 'Ada Lovelace',
  company: null,
  line1: '12 Rue de la Paix',
  line2: null,
  city: 'Paris',
  region: null,
  postalCode: '75002',
  country: 'FR',
  phone: null,
  email: null,
  ...over,
});

const request = (over: Partial<RateRequest> = {}): RateRequest => ({
  from: address({ name: 'Warehouse EU', city: 'Rotterdam', postalCode: '3011', country: 'NL' }),
  to: address({ country: 'NL', city: 'Amsterdam', postalCode: '1011' }),
  parcels: [{ lengthCm: 30, widthCm: 20, heightCm: 10, weightG: 1000 }],
  currency: 'EUR',
  ...over,
});

describe('manual carrier provider', () => {
  let provider: ReturnType<typeof createManualCarrierProvider>;
  beforeEach(() => {
    provider = createManualCarrierProvider();
  });

  it('prices domestic services from the table: base + per started kilogram', async () => {
    const rates = await provider.rates(request());
    expect(rates.map((rate) => rate.service)).toEqual(['manual_standard', 'manual_express']);
    expect(rates.map((rate) => rate.priceMinor)).toEqual([590, 1490]);
    expect(rates[0]).toMatchObject({
      provider: 'manual',
      carrier: 'manual',
      currency: 'EUR',
      estimatedDays: 3,
    });
  });

  it('charges a started kilogram: 1 g and 1000 g cost the same, 1001 g one more', async () => {
    const light = await provider.rates(request({ parcels: [parcel(1)] }));
    const exact = await provider.rates(request({ parcels: [parcel(1000)] }));
    const over = await provider.rates(request({ parcels: [parcel(1001)] }));
    expect(light[0]!.priceMinor).toBe(590);
    expect(exact[0]!.priceMinor).toBe(590);
    expect(over[0]!.priceMinor).toBe(690);
  });

  it('sums the weight of every parcel', async () => {
    const rates = await provider.rates(request({ parcels: [parcel(600), parcel(600)] }));
    expect(rates[0]!.priceMinor).toBe(690); // 1200 g → 2 started kg
  });

  it('switches to the international zone when the countries differ', async () => {
    const rates = await provider.rates(request({ to: address({ country: 'US' }) }));
    expect(rates.map((rate) => rate.service)).toEqual(['manual_international']);
    expect(rates[0]!.priceMinor).toBe(1990 + 450);
  });

  it('is deterministic: the same request yields the same prices and rate ids', async () => {
    const first = await provider.rates(request());
    const second = await createManualCarrierProvider().rates(request());
    expect(second).toEqual(first);
    expect(first[0]!.rateId).toMatch(/^manrate_[0-9a-f]{16}$/);
  });

  it('returns nothing for a currency the table is not priced in, and filters by service', async () => {
    expect(await provider.rates(request({ currency: 'CHF' }))).toEqual([]);
    const filtered = await provider.rates(request({ services: ['manual_express'] }));
    expect(filtered.map((rate) => rate.service)).toEqual(['manual_express']);
  });

  it('refuses a request without a parcel', async () => {
    await expect(provider.rates(request({ parcels: [] }))).rejects.toBeInstanceOf(CarrierError);
  });

  it('buys a label for a quoted rate and repeats the same label for the same shipment', async () => {
    const [rate] = await provider.rates(request());
    const label = await provider.buyLabel({ rateId: rate!.rateId, reference: 'shp-1' });
    expect(label).toMatchObject({
      provider: 'manual',
      carrier: 'manual',
      costMinor: rate!.priceMinor,
      currency: 'EUR',
      labelFormat: 'pdf',
    });
    expect(label.trackingNumber).toMatch(/^MAN[0-9A-F]{16}$/);
    expect(label.labelUrl).toBe(`https://labels.example/${label.providerShipmentId}.pdf`);
    expect(label.trackingUrl).toBe(`https://tracking.example/${label.trackingNumber}`);
    const again = await provider.buyLabel({ rateId: rate!.rateId, reference: 'shp-1' });
    expect(again).toEqual(label);
    const other = await provider.buyLabel({ rateId: rate!.rateId, reference: 'shp-2' });
    expect(other.providerShipmentId).not.toBe(label.providerShipmentId);
  });

  it('refuses to buy a label for an unknown rate', async () => {
    await expect(provider.buyLabel({ rateId: 'manrate_nope' })).rejects.toMatchObject({
      name: 'CarrierError',
      status: 404,
    });
  });

  it('tracks a bought label and records the scans it is advanced through', async () => {
    const [rate] = await provider.rates(request());
    const label = await provider.buyLabel({ rateId: rate!.rateId, reference: 'shp-3' });
    expect(await provider.track({ trackingNumber: label.trackingNumber })).toMatchObject([
      { status: 'pre_transit', trackingNumber: label.trackingNumber },
    ]);
    provider.advanceTracking(label.providerShipmentId, 'in_transit', '2026-09-08T10:00:00.000Z');
    provider.advanceTracking(label.providerShipmentId, 'delivered', '2026-09-09T09:30:00.000Z');
    const events = await provider.track({ trackingNumber: label.trackingNumber });
    expect(events.map((event) => event.status)).toEqual(['pre_transit', 'in_transit', 'delivered']);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(3);
    expect(await provider.track({ trackingNumber: 'MANUNKNOWN' })).toEqual([]);
  });

  it('voids a label before the first movement and refuses afterwards', async () => {
    const [rate] = await provider.rates(request());
    const first = await provider.buyLabel({ rateId: rate!.rateId, reference: 'shp-4' });
    expect(await provider.voidLabel({ providerShipmentId: first.providerShipmentId })).toEqual({
      voided: true,
      refundStatus: 'refunded',
    });
    const second = await provider.buyLabel({ rateId: rate!.rateId, reference: 'shp-5' });
    provider.advanceTracking(second.providerShipmentId, 'in_transit');
    await expect(
      provider.voidLabel({ providerShipmentId: second.providerShipmentId }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(provider.voidLabel({ providerShipmentId: 'manshp_nope' })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('validates an address without echoing it back', async () => {
    const good = await provider.validateAddress!(address());
    expect(good.valid).toBe(true);
    expect(good.normalized).toMatchObject({ country: 'FR' });
    const bad = await provider.validateAddress!(address({ line1: '  ', country: 'fra' }));
    expect(bad.valid).toBe(false);
    expect(bad.normalized).toBeNull();
    expect(bad.messages).toEqual(['line1 is empty', 'country is not an ISO-3166 alpha-2 code']);
    expect(bad.messages.join(' ')).not.toContain('Lovelace');
  });

  it('accepts a custom price table and provider name', async () => {
    const custom = createManualCarrierProvider(
      {
        ...DEFAULT_MANUAL_CONFIG,
        carrier: 'post-nl',
        currencies: ['EUR'],
        services: [
          {
            service: 'nl_std',
            serviceName: 'PostNL Standard',
            zone: 'domestic',
            baseMinor: 395,
            perKgMinor: 0,
            estimatedDays: 2,
          },
        ],
        trackingUrlTemplate: null,
      },
      'post-nl',
    );
    const [rate] = await custom.rates(request());
    expect(rate).toMatchObject({ provider: 'post-nl', carrier: 'post-nl', priceMinor: 395 });
    const label = await custom.buyLabel({ rateId: rate!.rateId });
    expect(label.trackingUrl).toBeNull();
  });

  it('exports a shared built-in instance that can be reset', async () => {
    const [rate] = await manualCarrierProvider.rates(request());
    await manualCarrierProvider.buyLabel({ rateId: rate!.rateId, reference: 'shared' });
    manualCarrierProvider.reset();
    await expect(manualCarrierProvider.buyLabel({ rateId: rate!.rateId })).rejects.toMatchObject({
      status: 404,
    });
  });
});

function parcel(weightG: number) {
  return { lengthCm: 30, widthCm: 20, heightCm: 10, weightG };
}
