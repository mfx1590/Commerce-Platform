// The `manual` carrier: a store that prints its own labels or hands parcels to a counter. It talks to nothing —
// rates come from a price table, ids are derived from the input (deterministic, so tests assert on them), and the
// bought labels live in a Map for the lifetime of the process. It is the default provider of every store, the
// fallback when a carrier is down (task 2.2) and the fixture every other test uses.
import { createHash } from 'node:crypto';
import { BoundedTtlMap } from './bounded-map';
import { CarrierError } from './redact';
import type {
  AddressValidation,
  BuyLabelRequest,
  CarrierAddress,
  CarrierLabel,
  CarrierProvider,
  CarrierRate,
  LabelFormat,
  Parcel,
  RateRequest,
  TrackRequest,
  TrackingEvent,
  TrackingStatus,
  VoidLabelRequest,
  VoidLabelResult,
} from './types';

/** One row of the manual price table: a flat base plus a charge per started kilogram. */
export interface ManualService {
  service: string;
  serviceName: string;
  /** `domestic` applies when origin and destination country match, `international` otherwise. */
  zone: 'domestic' | 'international';
  baseMinor: number;
  perKgMinor: number;
  estimatedDays: number | null;
}

export interface ManualCarrierConfig {
  /** Carrier name written on the shipment row. */
  carrier: string;
  /** Currencies this table is priced in. A `rates()` call in another currency returns []. */
  currencies: string[];
  services: ManualService[];
  /** Base of the tracking URL; `{tracking}` is replaced by the number. Null = no tracking URL. */
  trackingUrlTemplate: string | null;
  /** Base of the label URL; `{id}` is replaced by the provider shipment id. */
  labelUrlTemplate: string;
}

export const DEFAULT_MANUAL_CONFIG: ManualCarrierConfig = {
  carrier: 'manual',
  currencies: ['EUR', 'GBP', 'USD'],
  services: [
    {
      service: 'manual_standard',
      serviceName: 'Standard delivery',
      zone: 'domestic',
      baseMinor: 490,
      perKgMinor: 100,
      estimatedDays: 3,
    },
    {
      service: 'manual_express',
      serviceName: 'Express delivery',
      zone: 'domestic',
      baseMinor: 1290,
      perKgMinor: 200,
      estimatedDays: 1,
    },
    {
      service: 'manual_international',
      serviceName: 'International delivery',
      zone: 'international',
      baseMinor: 1990,
      perKgMinor: 450,
      estimatedDays: 7,
    },
  ],
  trackingUrlTemplate: 'https://tracking.example/{tracking}',
  labelUrlTemplate: 'https://labels.example/{id}.pdf',
};

interface StoredLabel {
  label: CarrierLabel;
  events: TrackingEvent[];
  voided: boolean;
}

/** `sha1(parts)` shortened — deterministic ids without a random source, so every test asserts on a fixed value. */
function digest(...parts: string[]): string {
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

const totalWeightG = (parcels: Parcel[]): number =>
  parcels.reduce((sum, parcel) => sum + parcel.weightG, 0);

/** Charge per *started* kilogram: 1 g and 1000 g both cost one unit, 1001 g costs two. */
const startedKg = (weightG: number): number => Math.max(1, Math.ceil(weightG / 1000));

export interface ManualProviderLimits {
  /** Quotes kept for a later `buyLabel`, and for how long (default 500 entries, 30 minutes). */
  rateIndexMaxEntries?: number;
  rateIndexTtlMs?: number;
  /** Bought labels kept for `track` and `voidLabel` (default 1000 entries, 24 hours). */
  labelMaxEntries?: number;
  labelTtlMs?: number;
}

export function createManualCarrierProvider(
  config: ManualCarrierConfig = DEFAULT_MANUAL_CONFIG,
  name = 'manual',
  limits: ManualProviderLimits = {},
): CarrierProvider & {
  /** Records a carrier scan on a bought label. Tests and the local webhook fixture of task 2.3 use it. */
  advanceTracking(
    providerShipmentId: string,
    status: TrackingStatus,
    occurredAt?: string,
  ): TrackingEvent;
  /** Forgets every bought label. Tests only. */
  reset(): void;
} {
  // Both indexes are bounded and expiring: this provider lives for the life of the process.
  const labels = new BoundedTtlMap<StoredLabel>({
    maxEntries: limits.labelMaxEntries ?? 1000,
    ttlMs: limits.labelTtlMs ?? 24 * 60 * 60_000,
  });
  const rateIndex = new BoundedTtlMap<{ rate: CarrierRate; request: RateRequest }>({
    maxEntries: limits.rateIndexMaxEntries ?? 500,
    ttlMs: limits.rateIndexTtlMs ?? 30 * 60_000,
  });

  const rates = async (request: RateRequest): Promise<CarrierRate[]> => {
    const currency = request.currency.toUpperCase();
    if (!config.currencies.includes(currency)) return [];
    if (request.parcels.length === 0) {
      throw new CarrierError(name, 400, 'rates', 'at least one parcel is required');
    }
    const zone =
      request.from.country.toUpperCase() === request.to.country.toUpperCase()
        ? 'domestic'
        : 'international';
    const kg = startedKg(totalWeightG(request.parcels));
    const wanted = request.services ?? [];
    return config.services
      .filter((service) => service.zone === zone)
      .filter((service) => wanted.length === 0 || wanted.includes(service.service))
      .map((service) => {
        const priceMinor = service.baseMinor + service.perKgMinor * kg;
        const rate: CarrierRate = {
          provider: name,
          rateId: `manrate_${digest(name, service.service, currency, String(kg), zone)}`,
          carrier: config.carrier,
          service: service.service,
          serviceName: service.serviceName,
          priceMinor,
          currency,
          estimatedDays: service.estimatedDays,
        };
        rateIndex.set(rate.rateId, { rate, request });
        return rate;
      });
  };

  const buyLabel = async (request: BuyLabelRequest): Promise<CarrierLabel> => {
    const quoted = rateIndex.get(request.rateId);
    if (!quoted) {
      throw new CarrierError(name, 404, 'buyLabel', `unknown rate ${request.rateId}`);
    }
    const providerShipmentId = `manshp_${digest(request.rateId, request.reference ?? '')}`;
    const existing = labels.get(providerShipmentId);
    // Buying the same rate for the same shipment twice returns the first label: our own retry must not
    // produce a second parcel at the carrier.
    if (existing) return existing.label;
    const trackingNumber = `MAN${digest(providerShipmentId).toUpperCase()}`;
    const labelFormat: LabelFormat = request.labelFormat ?? 'pdf';
    const label: CarrierLabel = {
      provider: name,
      providerShipmentId,
      rateId: request.rateId,
      carrier: quoted.rate.carrier,
      service: quoted.rate.service,
      trackingNumber,
      trackingUrl: config.trackingUrlTemplate
        ? config.trackingUrlTemplate.replace('{tracking}', trackingNumber)
        : null,
      labelUrl: config.labelUrlTemplate.replace('{id}', providerShipmentId),
      labelFormat,
      costMinor: quoted.rate.priceMinor,
      currency: quoted.rate.currency,
    };
    labels.set(providerShipmentId, {
      label,
      voided: false,
      events: [
        {
          eventId: `manevt_${digest(providerShipmentId, 'pre_transit')}`,
          trackingNumber,
          carrier: label.carrier,
          status: 'pre_transit',
          statusDetail: 'Label created',
          occurredAt: '1970-01-01T00:00:00.000Z',
          location: null,
        },
      ],
    });
    return label;
  };

  const voidLabel = async (request: VoidLabelRequest): Promise<VoidLabelResult> => {
    const stored = labels.get(request.providerShipmentId);
    if (!stored) {
      throw new CarrierError(
        name,
        404,
        'voidLabel',
        `unknown shipment ${request.providerShipmentId}`,
      );
    }
    if (stored.events.some((event) => event.status !== 'pre_transit')) {
      throw new CarrierError(name, 409, 'voidLabel', 'shipment has already moved');
    }
    stored.voided = true;
    return { voided: true, refundStatus: 'refunded' };
  };

  const track = async (request: TrackRequest): Promise<TrackingEvent[]> => {
    for (const stored of labels.values()) {
      if (stored.label.trackingNumber === request.trackingNumber) return [...stored.events];
    }
    return [];
  };

  /** Cheap sanity check; a real carrier's validator replaces it. Nothing about the address is echoed back. */
  const validateAddress = async (address: CarrierAddress): Promise<AddressValidation> => {
    const messages: string[] = [];
    if (address.name.trim() === '') messages.push('name is empty');
    if (address.line1.trim() === '') messages.push('line1 is empty');
    if (address.city.trim() === '') messages.push('city is empty');
    if (address.postalCode.trim() === '') messages.push('postal code is empty');
    if (!/^[A-Z]{2}$/.test(address.country))
      messages.push('country is not an ISO-3166 alpha-2 code');
    return {
      valid: messages.length === 0,
      normalized:
        messages.length === 0
          ? {
              ...address,
              country: address.country.toUpperCase(),
              postalCode: address.postalCode.trim(),
            }
          : null,
      messages,
    };
  };

  const advanceTracking = (
    providerShipmentId: string,
    status: TrackingStatus,
    occurredAt = '1970-01-01T00:00:00.000Z',
  ): TrackingEvent => {
    const stored = labels.get(providerShipmentId);
    if (!stored) {
      throw new CarrierError(
        name,
        404,
        'advanceTracking',
        `unknown shipment ${providerShipmentId}`,
      );
    }
    const event: TrackingEvent = {
      eventId: `manevt_${digest(providerShipmentId, status, occurredAt)}`,
      trackingNumber: stored.label.trackingNumber,
      carrier: stored.label.carrier,
      status,
      statusDetail: null,
      occurredAt,
      location: null,
    };
    stored.events.push(event);
    return event;
  };

  return {
    name,
    rates,
    buyLabel,
    voidLabel,
    track,
    validateAddress,
    advanceTracking,
    reset: () => {
      labels.clear();
      rateIndex.clear();
    },
  };
}

/** The built-in instance the registry serves under `manual`. */
export const manualCarrierProvider = createManualCarrierProvider();
