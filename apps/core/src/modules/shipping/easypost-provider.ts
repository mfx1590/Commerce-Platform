// EasyPost carrier provider over Node's global fetch (no SDK: one HTTP shape, no transitive dependencies, and the
// request/response mapping stays readable). Phase 2 runs in **test mode** only — `createEasyPostProvider` refuses
// a live key (`EZAK…`) unless `allowLiveKey` is set explicitly, which nothing in Phase 2 does.
//
// The API key comes from the environment (`easyPostCredentialsFor`, ADR 0006) and is used as the Basic-auth user.
// It is never logged, never embedded in an error and never returned. Addresses are sent to EasyPost (that is the
// point) but never written to a log: `CarrierError` carries the status and EasyPost's message only.
import { BoundedTtlMap } from './bounded-map';
import { isTestModeKey } from './config';
import { toMinorUnits } from './money';
import { CarrierError, isRetryableStatus } from './redact';
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

export const EASYPOST_BASE_URL = 'https://api.easypost.com/v2';

export interface EasyPostOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in milliseconds (default 15 s). A timeout is a retryable `CarrierError` with status 0. */
  timeoutMs?: number;
  /**
   * How many times a *safe* call (rates, track, address validation) is attempted in total when EasyPost answers
   * a retryable status — 0, 408, 429 or 5xx. Default 3, minimum 1. Buying and voiding a label are never retried:
   * a 5xx can arrive after the label was created, and a second attempt would buy a second parcel.
   */
  maxAttempts?: number;
  /** Delay before the first retry in milliseconds; doubles per attempt (default 200). */
  retryBaseDelayMs?: number;
  /** Injected in tests so backoff costs no wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  /** Entries kept in the rate → shipment index, and how long (default 500 entries, 30 minutes). */
  rateIndexMaxEntries?: number;
  rateIndexTtlMs?: number;
  /** Clock of the rate index; injected in tests so expiry is deterministic. */
  now?: () => number;
  /** Set only to talk to a live EasyPost account. Phase 2 never does. */
  allowLiveKey?: boolean;
  /** Provider name in the registry (default `easypost`). */
  name?: string;
}

/** EasyPost speaks inches and ounces; we store centimetres and grams. */
const CM_PER_INCH = 2.54;
const GRAMS_PER_OUNCE = 28.349523125;
const toInches = (cm: number): number => round(cm / CM_PER_INCH, 2);
const toOunces = (g: number): number => round(g / GRAMS_PER_OUNCE, 2);
const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** EasyPost tracker statuses → ours. Anything new stays `unknown` rather than being guessed at. */
const TRACKING_STATUS: Record<string, TrackingStatus> = {
  unknown: 'unknown',
  pre_transit: 'pre_transit',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  available_for_pickup: 'available_for_pickup',
  return_to_sender: 'return_to_sender',
  failure: 'failure',
  cancelled: 'cancelled',
  error: 'failure',
};

export function easyPostTrackingStatus(status: string | null | undefined): TrackingStatus {
  return (status ? TRACKING_STATUS[status] : undefined) ?? 'unknown';
}

interface EasyPostRate {
  id?: string;
  carrier?: string;
  service?: string;
  rate?: string;
  currency?: string;
  delivery_days?: number | null;
  est_delivery_days?: number | null;
}

interface EasyPostShipment {
  id?: string;
  rates?: EasyPostRate[];
  selected_rate?: EasyPostRate;
  tracking_code?: string;
  tracker?: { public_url?: string; tracking_details?: EasyPostTrackingDetail[]; status?: string };
  postage_label?: { label_url?: string; label_file_type?: string };
  refund_status?: string;
}

interface EasyPostTrackingDetail {
  object_id?: string;
  id?: string;
  status?: string;
  message?: string;
  datetime?: string;
  tracking_location?: {
    city?: string | null;
    state?: string | null;
    country?: string | null;
  } | null;
}

interface EasyPostTracker {
  tracking_code?: string;
  carrier?: string;
  tracking_details?: EasyPostTrackingDetail[];
}

interface EasyPostAddress {
  verifications?: {
    delivery?: { success?: boolean; errors?: { message?: string }[] };
  };
  name?: string;
  company?: string | null;
  street1?: string;
  street2?: string | null;
  city?: string;
  state?: string | null;
  zip?: string;
  country?: string;
  phone?: string | null;
  email?: string | null;
}

/**
 * Builds the provider. Register it at boot with `setCarrierProvider(createEasyPostProvider({ apiKey }))`; the key
 * comes from `easyPostCredentialsFor(storeCode)`, never from code.
 */
export function createEasyPostProvider(options: EasyPostOptions): CarrierProvider {
  const {
    apiKey,
    baseUrl = EASYPOST_BASE_URL,
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs = 15_000,
    maxAttempts = 3,
    retryBaseDelayMs = 200,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    rateIndexMaxEntries = 500,
    rateIndexTtlMs = 30 * 60_000,
    now,
    allowLiveKey = false,
    name = 'easypost',
  } = options;
  if (!apiKey) throw new Error('easypost: apiKey is required');
  if (!isTestModeKey(apiKey) && !allowLiveKey) {
    throw new Error(
      'easypost: refusing a non-test API key (Phase 2 is test mode only; pass allowLiveKey to override)',
    );
  }
  const authorization = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
  // EasyPost buys a label on a *shipment*, not on a rate: remember which shipment each quote belongs to.
  // Bounded and expiring — a quote is only useful until the storefront moves on.
  const shipmentOfRate = new BoundedTtlMap<string>({
    maxEntries: rateIndexMaxEntries,
    ttlMs: rateIndexTtlMs,
    ...(now ? { now } : {}),
  });

  /**
   * Attempts a safe call up to `maxAttempts` times while EasyPost answers a retryable status, doubling the delay
   * from `retryBaseDelayMs`. `retry: false` (buying and voiding a label) attempts exactly once.
   */
  async function call<T>(
    operation: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    retry = false,
  ): Promise<T> {
    const attempts = retry ? Math.max(1, maxAttempts) : 1;
    let lastError: CarrierError | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await callOnce<T>(operation, method, path, body);
      } catch (error) {
        if (!(error instanceof CarrierError) || !error.retryable || attempt === attempts)
          throw error;
        lastError = error;
        await sleep(retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }
    /* istanbul ignore next — the loop either returns or throws */
    throw lastError;
  }

  async function callOnce<T>(
    operation: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
          'User-Agent': 'platform-core-shipping/0.1',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      // Network failure or timeout: no address, no key, just why it failed.
      throw new CarrierError(name, 0, operation, messageOf(error), true);
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new CarrierError(
        name,
        response.status,
        operation,
        easyPostErrorMessage(text),
        isRetryableStatus(response.status),
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CarrierError(name, response.status, operation, 'response was not JSON', true);
    }
  }

  const rates = async (request: RateRequest): Promise<CarrierRate[]> => {
    if (request.parcels.length === 0) {
      throw new CarrierError(name, 400, 'rates', 'at least one parcel is required');
    }
    if (request.parcels.length > 1) {
      // EasyPost prices one parcel per shipment; multi-box goes through one shipment per parcel (task 2.3).
      throw new CarrierError(name, 400, 'rates', 'one parcel per rate request');
    }
    const currency = request.currency.toUpperCase();
    const shipment = await call<EasyPostShipment>(
      'rates',
      'POST',
      '/shipments',
      {
        shipment: {
          to_address: toEasyPostAddress(request.to),
          from_address: toEasyPostAddress(request.from),
          parcel: toEasyPostParcel(request.parcels[0]!),
          ...(request.carrierAccountIds && request.carrierAccountIds.length > 0
            ? { carrier_accounts: request.carrierAccountIds.map((id) => ({ id })) }
            : {}),
        },
      },
      true,
    );
    const shipmentId = shipment.id;
    const wanted = request.services ?? [];
    const out: CarrierRate[] = [];
    for (const rate of shipment.rates ?? []) {
      if (!rate.id || !rate.rate || !rate.carrier || !rate.service) continue;
      // No FX in the core: a rate quoted in another currency than the cart is dropped, never converted.
      if ((rate.currency ?? '').toUpperCase() !== currency) continue;
      if (wanted.length > 0 && !wanted.includes(rate.service)) continue;
      if (shipmentId) shipmentOfRate.set(rate.id, shipmentId);
      out.push({
        provider: name,
        rateId: rate.id,
        carrier: rate.carrier,
        service: rate.service,
        serviceName: `${rate.carrier} ${rate.service}`,
        priceMinor: toMinorUnits(rate.rate, currency),
        currency,
        estimatedDays: rate.delivery_days ?? rate.est_delivery_days ?? null,
      });
    }
    return out;
  };

  const buyLabel = async (request: BuyLabelRequest): Promise<CarrierLabel> => {
    const shipmentId = request.providerShipmentId ?? shipmentOfRate.get(request.rateId);
    if (!shipmentId) {
      throw new CarrierError(
        name,
        400,
        'buyLabel',
        `no shipment known for rate ${request.rateId}; pass providerShipmentId`,
      );
    }
    const labelFormat: LabelFormat = request.labelFormat ?? 'pdf';
    const shipment = await call<EasyPostShipment>(
      'buyLabel',
      'POST',
      `/shipments/${encodeURIComponent(shipmentId)}/buy`,
      {
        rate: { id: request.rateId },
        label_format: labelFormat.toUpperCase(),
        ...(request.reference ? { reference: request.reference } : {}),
      },
    );
    const selected = shipment.selected_rate;
    const labelUrl = shipment.postage_label?.label_url;
    if (!selected?.rate || !selected.currency || !shipment.tracking_code || !labelUrl) {
      throw new CarrierError(
        name,
        502,
        'buyLabel',
        'label response is missing rate, tracking or label url',
      );
    }
    const currency = selected.currency.toUpperCase();
    return {
      provider: name,
      providerShipmentId: shipment.id ?? shipmentId,
      rateId: request.rateId,
      carrier: selected.carrier ?? 'unknown',
      service: selected.service ?? 'unknown',
      trackingNumber: shipment.tracking_code,
      trackingUrl: shipment.tracker?.public_url ?? null,
      labelUrl,
      labelFormat,
      costMinor: toMinorUnits(selected.rate, currency),
      currency,
    };
  };

  const voidLabel = async (request: VoidLabelRequest): Promise<VoidLabelResult> => {
    const shipment = await call<EasyPostShipment>(
      'voidLabel',
      'POST',
      `/shipments/${encodeURIComponent(request.providerShipmentId)}/refund`,
      undefined,
    );
    const status = shipment.refund_status ?? 'unknown';
    return { voided: status === 'submitted' || status === 'refunded', refundStatus: status };
  };

  const track = async (request: TrackRequest): Promise<TrackingEvent[]> => {
    const query = new URLSearchParams({ tracking_code: request.trackingNumber });
    const body = await call<{ trackers?: EasyPostTracker[] }>(
      'track',
      'GET',
      `/trackers?${query.toString()}`,
      undefined,
      true,
    );
    const tracker = (body.trackers ?? []).find(
      (candidate) => candidate.tracking_code === request.trackingNumber,
    );
    if (!tracker) return [];
    return (tracker.tracking_details ?? []).map((detail) =>
      trackingEventOf(
        detail,
        request.trackingNumber,
        tracker.carrier ?? request.carrier ?? 'unknown',
      ),
    );
  };

  const validateAddress = async (address: CarrierAddress): Promise<AddressValidation> => {
    const body = await call<EasyPostAddress>(
      'validateAddress',
      'POST',
      '/addresses',
      { address: { ...toEasyPostAddress(address), verify_strict: ['delivery'] } },
      true,
    );
    const delivery = body.verifications?.delivery;
    const messages = (delivery?.errors ?? [])
      .map((error) => error.message)
      .filter((message): message is string => typeof message === 'string');
    const valid = delivery?.success === true;
    return {
      valid,
      normalized: valid ? fromEasyPostAddress(body, address) : null,
      messages,
    };
  };

  return { name, rates, buyLabel, voidLabel, track, validateAddress };
}

/** Exported for task 2.3's webhook receiver: the same mapping for a `tracker.updated` payload. */
export function trackingEventOf(
  detail: EasyPostTrackingDetail,
  trackingNumber: string,
  carrier: string,
): TrackingEvent {
  const location = detail.tracking_location;
  return {
    eventId:
      detail.object_id ??
      detail.id ??
      `${trackingNumber}:${detail.datetime ?? ''}:${detail.status ?? ''}`,
    trackingNumber,
    carrier,
    status: easyPostTrackingStatus(detail.status),
    statusDetail: detail.message ?? null,
    occurredAt: detail.datetime ?? new Date(0).toISOString(),
    location: location
      ? {
          city: location.city ?? null,
          region: location.state ?? null,
          country: location.country ?? null,
        }
      : null,
  };
}

function toEasyPostAddress(address: CarrierAddress): Record<string, unknown> {
  return {
    name: address.name,
    company: address.company,
    street1: address.line1,
    street2: address.line2,
    city: address.city,
    state: address.region,
    zip: address.postalCode,
    country: address.country,
    phone: address.phone,
    email: address.email,
  };
}

function fromEasyPostAddress(body: EasyPostAddress, fallback: CarrierAddress): CarrierAddress {
  return {
    name: body.name ?? fallback.name,
    company: body.company ?? null,
    line1: body.street1 ?? fallback.line1,
    line2: body.street2 ?? null,
    city: body.city ?? fallback.city,
    region: body.state ?? null,
    postalCode: body.zip ?? fallback.postalCode,
    country: (body.country ?? fallback.country).toUpperCase(),
    phone: body.phone ?? null,
    email: body.email ?? null,
  };
}

function toEasyPostParcel(parcel: Parcel): Record<string, number> {
  return {
    length: toInches(parcel.lengthCm),
    width: toInches(parcel.widthCm),
    height: toInches(parcel.heightCm),
    weight: toOunces(parcel.weightG),
  };
}

/** EasyPost errors are `{ error: { message, code } }`; `message` can be a string or a list of field errors. */
function easyPostErrorMessage(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown; code?: unknown } };
    const message = body.error?.message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) {
      return message
        .map((entry) =>
          typeof entry === 'string'
            ? entry
            : String((entry as { message?: unknown })?.message ?? 'invalid field'),
        )
        .join('; ');
    }
    if (typeof body.error?.code === 'string') return body.error.code;
  } catch {
    /* fall through: a non-JSON body says nothing useful and may echo the request */
  }
  return 'request rejected';
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'AbortError' ? 'request timed out' : error.message;
  }
  return 'request failed';
}
