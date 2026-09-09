// EasyPost request shaping and response mapping against a fake fetch: auth header, unit conversion, currency
// filtering, label purchase, void, tracking, address validation, and what an error is allowed to say.
import { describe, expect, it, vi } from 'vitest';
import {
  createEasyPostProvider,
  easyPostTrackingStatus,
  trackingEventOf,
} from './easypost-provider';
import type { CarrierAddress, RateRequest } from './types';

const KEY = 'EZTK_test_key_do_not_use';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

/** A fetch stub that answers each call from a queue and records what it was given. */
function fakeFetch(responses: { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const next = responses.shift() ?? {
      status: 500,
      body: { error: { message: 'no response queued' } },
    };
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const from: CarrierAddress = {
  name: 'Warehouse EU',
  company: 'Platform BV',
  line1: 'Havenweg 1',
  line2: null,
  city: 'Rotterdam',
  region: null,
  postalCode: '3011 AA',
  country: 'NL',
  phone: null,
  email: null,
};
const to: CarrierAddress = {
  ...from,
  name: 'Ada Lovelace',
  company: null,
  city: 'Berlin',
  postalCode: '10115',
  country: 'DE',
};

const rateRequest = (over: Partial<RateRequest> = {}): RateRequest => ({
  from,
  to,
  parcels: [{ lengthCm: 30.48, widthCm: 20, heightCm: 10, weightG: 1000 }],
  currency: 'EUR',
  ...over,
});

const shipmentBody = {
  id: 'shp_123',
  rates: [
    {
      id: 'rate_eur',
      carrier: 'DHLExpress',
      service: 'ExpressWorldwide',
      rate: '12.34',
      currency: 'EUR',
      delivery_days: 2,
    },
    {
      id: 'rate_usd',
      carrier: 'UPS',
      service: 'UPSGround',
      rate: '9.99',
      currency: 'USD',
      delivery_days: 4,
    },
    {
      id: 'rate_eur2',
      carrier: 'DHLExpress',
      service: 'Economy',
      rate: '8.005',
      currency: 'eur',
      delivery_days: null,
    },
  ],
};

describe('EasyPost provider', () => {
  it('refuses a live key unless it is asked for explicitly', () => {
    expect(() => createEasyPostProvider({ apiKey: 'EZAK_live' })).toThrow(/test mode only/);
    expect(() => createEasyPostProvider({ apiKey: '' })).toThrow(/apiKey/);
    expect(() => createEasyPostProvider({ apiKey: 'EZAK_live', allowLiveKey: true })).not.toThrow();
  });

  it('sends Basic auth, converts centimetres and grams, and keeps only the requested currency', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: shipmentBody }]);
    const provider = createEasyPostProvider({ apiKey: KEY, fetch: fetchImpl });
    const rates = await provider.rates(rateRequest());

    expect(calls[0]!.url).toBe('https://api.easypost.com/v2/shipments');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`,
    );
    const shipment = calls[0]!.body!.shipment as Record<string, Record<string, unknown>>;
    expect(shipment.parcel).toEqual({ length: 12, width: 7.87, height: 3.94, weight: 35.27 });
    expect(shipment.to_address).toMatchObject({
      street1: 'Havenweg 1',
      zip: '10115',
      country: 'DE',
    });
    expect(shipment.carrier_accounts).toBeUndefined();

    // rate_usd is dropped (no FX in the core); "8.005" EUR rounds half away from zero to 801.
    expect(rates).toEqual([
      {
        provider: 'easypost',
        rateId: 'rate_eur',
        carrier: 'DHLExpress',
        service: 'ExpressWorldwide',
        serviceName: 'DHLExpress ExpressWorldwide',
        priceMinor: 1234,
        currency: 'EUR',
        estimatedDays: 2,
      },
      {
        provider: 'easypost',
        rateId: 'rate_eur2',
        carrier: 'DHLExpress',
        service: 'Economy',
        serviceName: 'DHLExpress Economy',
        priceMinor: 801,
        currency: 'EUR',
        estimatedDays: null,
      },
    ]);
  });

  it('passes carrier accounts and a service filter through', async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: shipmentBody }]);
    const provider = createEasyPostProvider({ apiKey: KEY, fetch: fetchImpl });
    const rates = await provider.rates(
      rateRequest({ carrierAccountIds: ['ca_1', 'ca_2'], services: ['Economy'] }),
    );
    const shipment = calls[0]!.body!.shipment as Record<string, unknown>;
    expect(shipment.carrier_accounts).toEqual([{ id: 'ca_1' }, { id: 'ca_2' }]);
    expect(rates.map((rate) => rate.service)).toEqual(['Economy']);
  });

  it('rejects zero parcels and multi-parcel requests before calling the carrier', async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const provider = createEasyPostProvider({ apiKey: KEY, fetch: fetchImpl });
    await expect(provider.rates(rateRequest({ parcels: [] }))).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      provider.rates(
        rateRequest({ parcels: [rateRequest().parcels[0]!, rateRequest().parcels[0]!] }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it('buys a label on the shipment the rate was quoted for', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: shipmentBody },
      {
        body: {
          id: 'shp_123',
          tracking_code: '1Z999',
          selected_rate: {
            id: 'rate_eur',
            carrier: 'DHLExpress',
            service: 'ExpressWorldwide',
            rate: '12.34',
            currency: 'EUR',
          },
          postage_label: { label_url: 'https://easypost-files.example/label_123.pdf' },
          tracker: { public_url: 'https://track.easypost.com/1Z999' },
        },
      },
    ]);
    const provider = createEasyPostProvider({ apiKey: KEY, fetch: fetchImpl });
    await provider.rates(rateRequest());
    const label = await provider.buyLabel({ rateId: 'rate_eur', reference: 'shipment-uuid' });

    expect(calls[1]!.url).toBe('https://api.easypost.com/v2/shipments/shp_123/buy');
    expect(calls[1]!.body).toEqual({
      rate: { id: 'rate_eur' },
      label_format: 'PDF',
      reference: 'shipment-uuid',
    });
    expect(label).toEqual({
      provider: 'easypost',
      providerShipmentId: 'shp_123',
      rateId: 'rate_eur',
      carrier: 'DHLExpress',
      service: 'ExpressWorldwide',
      trackingNumber: '1Z999',
      trackingUrl: 'https://track.easypost.com/1Z999',
      labelUrl: 'https://easypost-files.example/label_123.pdf',
      labelFormat: 'pdf',
      costMinor: 1234,
      currency: 'EUR',
    });
  });

  it('needs a shipment id when the rate was quoted in another process', async () => {
    const { fetchImpl } = fakeFetch([
      {
        body: {
          id: 'shp_9',
          tracking_code: 't',
          selected_rate: { rate: '1.00', currency: 'EUR' },
          postage_label: { label_url: 'u' },
        },
      },
    ]);
    const provider = createEasyPostProvider({ apiKey: KEY, fetch: fetchImpl });
    await expect(provider.buyLabel({ rateId: 'rate_eur' })).rejects.toMatchObject({ status: 400 });
    const label = await provider.buyLabel({ rateId: 'rate_eur', providerShipmentId: 'shp_9' });
    expect(label.providerShipmentId).toBe('shp_9');
  });

  it('treats an incomplete buy response as a bad gateway', async () => {
    const { fetchImpl } = fakeFetch([{ body: { id: 'shp_1', tracking_code: '1Z' } }]);
    const provider = createEasyPostProvider({ apiKey: KEY, fetch: fetchImpl });
    await expect(
      provider.buyLabel({ rateId: 'rate_eur', providerShipmentId: 'shp_1' }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('voids a label and reports the refund status', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { refund_status: 'submitted' } },
      { body: { refund_status: 'not_applicable' } },
    ]);
    const provider = createEasyPostProvider({ apiKey: KEY, fetch: fetchImpl });
    expect(await provider.voidLabel({ providerShipmentId: 'shp_123' })).toEqual({
      voided: true,
      refundStatus: 'submitted',
    });
    expect(calls[0]!.url).toBe('https://api.easypost.com/v2/shipments/shp_123/refund');
    expect(await provider.voidLabel({ providerShipmentId: 'shp_123' })).toEqual({
      voided: false,
      refundStatus: 'not_applicable',
    });
  });

  it('maps tracking details, keeping city-level location only', async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        body: {
          trackers: [
            {
              tracking_code: '1Z999',
              carrier: 'UPS',
              tracking_details: [
                {
                  object_id: 'evt_1',
                  status: 'in_transit',
                  message: 'Departed',
                  datetime: '2026-09-08T08:00:00Z',
                  tracking_location: { city: 'Köln', state: 'NRW', country: 'DE' },
                },
                {
                  object_id: 'evt_2',
                  status: 'delivered',
                  datetime: '2026-09-09T09:00:00Z',
                  tracking_location: null,
                },
                { object_id: 'evt_3', status: 'teleported', datetime: '2026-09-10T09:00:00Z' },
              ],
            },
          ],
        },
      },
      { body: { trackers: [] } },
    ]);
    const provider = createEasyPostProvider({ apiKey: KEY, fetch: fetchImpl });
    const events = await provider.track({ trackingNumber: '1Z999' });
    expect(calls[0]!.url).toBe('https://api.easypost.com/v2/trackers?tracking_code=1Z999');
    expect(events.map((event) => event.status)).toEqual(['in_transit', 'delivered', 'unknown']);
    expect(events[0]).toMatchObject({
      eventId: 'evt_1',
      carrier: 'UPS',
      statusDetail: 'Departed',
      occurredAt: '2026-09-08T08:00:00Z',
      location: { city: 'Köln', region: 'NRW', country: 'DE' },
    });
    expect(events[1]!.location).toBeNull();
    expect(await provider.track({ trackingNumber: 'nope' })).toEqual([]);
  });

  it('validates an address and returns the carrier normalisation', async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        body: {
          name: 'ADA LOVELACE',
          street1: 'HAVENWEG 1',
          city: 'BERLIN',
          zip: '10115',
          country: 'DE',
          verifications: { delivery: { success: true } },
        },
      },
      {
        body: {
          verifications: {
            delivery: { success: false, errors: [{ message: 'Address not found' }] },
          },
        },
      },
    ]);
    const provider = createEasyPostProvider({ apiKey: KEY, fetch: fetchImpl });
    const ok = await provider.validateAddress!(to);
    expect((calls[0]!.body!.address as Record<string, unknown>).verify_strict).toEqual([
      'delivery',
    ]);
    expect(ok).toEqual({
      valid: true,
      normalized: {
        name: 'ADA LOVELACE',
        company: null,
        line1: 'HAVENWEG 1',
        line2: null,
        city: 'BERLIN',
        region: null,
        postalCode: '10115',
        country: 'DE',
        phone: null,
        email: null,
      },
      messages: [],
    });
    const bad = await provider.validateAddress!(to);
    expect(bad).toEqual({ valid: false, normalized: null, messages: ['Address not found'] });
  });

  it('turns an API error into a CarrierError that carries no request payload', async () => {
    const { fetchImpl } = fakeFetch([
      {
        status: 422,
        body: {
          error: {
            message: [{ message: 'zip is required' }, 'city is required'],
            code: 'ADDRESS.INVALID',
          },
        },
      },
      { status: 503, body: { error: { code: 'SERVICE_UNAVAILABLE' } } },
      { status: 401, body: 'not json at all' },
    ]);
    // maxAttempts 1: this test is about the mapping, not the retry (covered below).
    const provider = createEasyPostProvider({ apiKey: KEY, fetch: fetchImpl, maxAttempts: 1 });
    const invalid = await provider.rates(rateRequest()).catch((error: unknown) => error as Error);
    expect(invalid.message).toBe('easypost rates failed (422): zip is required; city is required');
    expect(invalid.message).not.toContain('Havenweg');
    expect(invalid.message).not.toContain(KEY);
    expect(invalid).toMatchObject({ name: 'CarrierError', status: 422, retryable: false });

    await expect(provider.rates(rateRequest())).rejects.toMatchObject({
      status: 503,
      retryable: true,
    });
    await expect(provider.rates(rateRequest())).rejects.toMatchObject({
      status: 401,
      message: 'easypost rates failed (401): request rejected',
    });
  });

  it('reports a network failure and a timeout as retryable status 0', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const provider = createEasyPostProvider({
      apiKey: KEY,
      fetch: failing,
      maxAttempts: 1,
    });
    await expect(provider.rates(rateRequest())).rejects.toMatchObject({
      status: 0,
      retryable: true,
      message: 'easypost rates failed (0): fetch failed',
    });

    const hanging = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    ) as unknown as typeof globalThis.fetch;
    const impatient = createEasyPostProvider({
      apiKey: KEY,
      fetch: hanging,
      timeoutMs: 5,
      maxAttempts: 1,
    });
    await expect(impatient.rates(rateRequest())).rejects.toMatchObject({
      status: 0,
      retryable: true,
      message: 'easypost rates failed (0): request timed out',
    });
  });

  it('retries a retryable status with doubling backoff, up to maxAttempts', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 503, body: { error: { message: 'unavailable' } } },
      { status: 429, body: { error: { message: 'slow down' } } },
      { body: shipmentBody },
    ]);
    const slept: number[] = [];
    const provider = createEasyPostProvider({
      apiKey: KEY,
      fetch: fetchImpl,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    const rates = await provider.rates(rateRequest());
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([200, 400]);
    expect(rates.map((rate) => rate.rateId)).toEqual(['rate_eur', 'rate_eur2']);
  });

  it('gives up after maxAttempts and reports the last failure', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 500, body: { error: { message: 'boom' } } },
      { status: 500, body: { error: { message: 'boom' } } },
      { status: 500, body: { error: { message: 'boom' } } },
      { body: shipmentBody },
    ]);
    const provider = createEasyPostProvider({
      apiKey: KEY,
      fetch: fetchImpl,
      sleep: async () => {},
    });
    await expect(provider.rates(rateRequest())).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(3);
  });

  it('never retries a non-retryable status', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 422, body: { error: { message: 'bad address' } } },
      { body: shipmentBody },
    ]);
    const provider = createEasyPostProvider({
      apiKey: KEY,
      fetch: fetchImpl,
      sleep: async () => {},
    });
    await expect(provider.rates(rateRequest())).rejects.toMatchObject({ status: 422 });
    expect(calls).toHaveLength(1);
  });

  it('never retries buying or voiding a label: a 5xx may arrive after the label exists', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 503, body: { error: { message: 'unavailable' } } },
      { status: 503, body: { error: { message: 'unavailable' } } },
    ]);
    const provider = createEasyPostProvider({
      apiKey: KEY,
      fetch: fetchImpl,
      sleep: async () => {},
    });
    await expect(
      provider.buyLabel({ rateId: 'rate_eur', providerShipmentId: 'shp_1' }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(provider.voidLabel({ providerShipmentId: 'shp_1' })).rejects.toMatchObject({
      status: 503,
    });
    expect(calls).toHaveLength(2); // one attempt each
  });

  it('forgets a quote once the rate index expires', async () => {
    let clock = 0;
    const { fetchImpl } = fakeFetch([{ body: shipmentBody }]);
    const provider = createEasyPostProvider({
      apiKey: KEY,
      fetch: fetchImpl,
      rateIndexTtlMs: 1000,
      now: () => clock,
    });
    await provider.rates(rateRequest());
    clock += 2000;
    await expect(provider.buyLabel({ rateId: 'rate_eur' })).rejects.toMatchObject({ status: 400 });
  });

  it('maps tracker statuses, defaulting anything unknown', () => {
    expect(easyPostTrackingStatus('out_for_delivery')).toBe('out_for_delivery');
    expect(easyPostTrackingStatus('error')).toBe('failure');
    expect(easyPostTrackingStatus(undefined)).toBe('unknown');
    expect(easyPostTrackingStatus('brand new status')).toBe('unknown');
  });

  it('falls back to a synthetic event id when the tracker detail has none (task 2.3 idempotency)', () => {
    const event = trackingEventOf(
      { status: 'delivered', datetime: '2026-09-09T09:00:00Z' },
      '1Z999',
      'UPS',
    );
    expect(event.eventId).toBe('1Z999:2026-09-09T09:00:00Z:delivered');
    expect(trackingEventOf({}, '1Z999', 'UPS').occurredAt).toBe('1970-01-01T00:00:00.000Z');
  });
});
