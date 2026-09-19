// The in-memory 3PL behaves like a real one where it matters: forward-only progress, no free cancel once
// picking has started, tracking on shipment, and a push that can be made to fail.
import { describe, expect, it } from 'vitest';
import { createMemoryFulfillmentProvider } from './memory-provider';
import {
  fulfillmentProvider,
  fulfillmentProviderFor,
  resetFulfillmentProviders,
  setFulfillmentProvider,
} from './registry';
import { FulfillmentError, type FulfillmentRequest } from './types';

const request = (over: Partial<FulfillmentRequest> = {}): FulfillmentRequest => ({
  reference: 'shp_1',
  orderId: 'ord_1',
  warehouseCode: 'wh-eu',
  lines: [{ orderLineItemId: 'line_1', sku: 'SKU-1', quantity: 2 }],
  shipTo: {
    name: 'Jane Doe',
    company: null,
    line1: 'Keizersgracht 1',
    line2: null,
    city: 'Amsterdam',
    region: null,
    postalCode: '1015 CJ',
    country: 'NL',
    phone: null,
  },
  carrier: 'manual',
  service: null,
  ...over,
});

describe('memory fulfilment provider', () => {
  it('accepts a request and reports it back with our reference', async () => {
    const provider = createMemoryFulfillmentProvider();
    const ack = await provider.push(request());
    expect(ack.state).toBe('accepted');
    expect(ack.externalId).toMatch(/^ful_/);
    expect(await provider.status(ack.externalId)).toMatchObject({
      externalId: ack.externalId,
      reference: 'shp_1',
      state: 'accepted',
      trackingNumber: null,
    });
    expect(provider.requests()).toHaveLength(1);
  });

  it('cancels for free before picking and refuses once picking has started', async () => {
    const provider = createMemoryFulfillmentProvider();
    const early = await provider.push(request());
    expect(await provider.cancel(early.externalId)).toEqual({ cancelled: true });
    expect(await provider.cancel(early.externalId)).toEqual({ cancelled: true }); // idempotent

    const late = await provider.push(request({ reference: 'shp_2' }));
    provider.advance(late.externalId, 'picking');
    expect(await provider.cancel(late.externalId)).toEqual({
      cancelled: false,
      reason: 'already picking',
    });
  });

  it('moves forward only and needs tracking to ship', async () => {
    const provider = createMemoryFulfillmentProvider();
    const { externalId } = await provider.push(request());
    provider.advance(externalId, 'picking');
    provider.advance(externalId, 'packed');
    expect(() => provider.advance(externalId, 'picking')).toThrow(FulfillmentError);
    expect(() => provider.advance(externalId, 'shipped')).toThrow(/tracking number/);
    const shipped = provider.advance(externalId, 'shipped', {
      trackingNumber: 'TRK1',
      trackingUrl: 'https://track.example/TRK1',
    });
    expect(shipped).toMatchObject({ state: 'shipped', trackingNumber: 'TRK1' });
  });

  it('fails the next push on request, then recovers', async () => {
    const provider = createMemoryFulfillmentProvider();
    provider.failNextPush('warehouse offline');
    await expect(provider.push(request())).rejects.toMatchObject({
      name: 'FulfillmentError',
      retryable: true,
    });
    await expect(provider.push(request())).resolves.toMatchObject({ state: 'accepted' });
  });

  it('refuses an empty request and an unknown job', async () => {
    const provider = createMemoryFulfillmentProvider();
    await expect(provider.push(request({ lines: [] }))).rejects.toThrow(FulfillmentError);
    await expect(provider.status('ful_missing')).rejects.toThrow(/unknown fulfilment/);
  });
});

describe('fulfilment provider registry', () => {
  it('uses the store setting when it names a registered provider, else the in-memory default', () => {
    resetFulfillmentProviders();
    const other = createMemoryFulfillmentProvider('acme-3pl');
    expect(setFulfillmentProvider(other)).toBeUndefined();
    expect(fulfillmentProviderFor({ fulfillment: { provider: 'acme-3pl' } })).toBe(other);
    expect(fulfillmentProviderFor({ fulfillment: { provider: 'nobody' } }).name).toBe('memory');
    expect(fulfillmentProviderFor(null).name).toBe('memory');
    expect(fulfillmentProvider('acme-3pl')).toBe(other);
    resetFulfillmentProviders();
    expect(fulfillmentProvider('acme-3pl')).toBeUndefined();
  });
});
