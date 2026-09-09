// Rate shopping: the option table decides what exists and who is eligible, the carrier decides what a live
// option costs, and a carrier that cannot answer falls back to the flat table price. The transaction is a stub
// that answers the four statements the provider issues — the SQL itself is exercised in `rate-shopping-db.test.ts`.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PricingContext } from '../cart';
import { createManualCarrierProvider } from './manual-provider';
import { createCarrierRateProvider, parseRules } from './rate-shopping';
import { resetCarrierProviders, setCarrierProvider } from './registry';
import { CarrierError } from './redact';
import type { CarrierProvider } from './types';

const STORE = '11111111-1111-1111-1111-111111111111';
const ORG = '22222222-2222-2222-2222-222222222222';
const CHANNEL = '33333333-3333-3333-3333-333333333333';

interface OptionFixture {
  id: string;
  code: string;
  name: string;
  carrier: string;
  service: string | null;
  price_minor: string;
  currency: string;
  rules: Record<string, unknown>;
}

const option = (over: Partial<OptionFixture> = {}): OptionFixture => ({
  id: `opt-${over.code ?? 'std'}`,
  code: 'std',
  name: 'Standard',
  carrier: 'manual',
  service: null,
  price_minor: '590',
  currency: 'EUR',
  rules: {},
  ...over,
});

const WAREHOUSE = {
  address: {
    line1: 'Havenweg 1',
    city: 'Rotterdam',
    postal_code: '3011 AA',
    country: 'NL',
    first_name: 'Warehouse',
    last_name: 'EU',
  },
  country: 'NL',
};

interface StubState {
  options: OptionFixture[];
  store: { code: string; settings: Record<string, unknown> | null } | null;
  warehouses: { address: unknown; country: string }[];
  weights: { id: string; weight_g: number | null }[];
}

/** A `Queryable` that answers by looking at which table the statement reads. Records every statement. */
function stubTx(state: StubState) {
  const seen: string[] = [];
  const tx = {
    async query(text: string, params?: unknown[]) {
      seen.push(text);
      if (text.includes('FROM shipping_option')) {
        const wantedId = params?.[4] ?? null;
        const rows = state.options.filter((o) => wantedId === null || o.id === wantedId);
        return { rows, rowCount: rows.length };
      }
      if (text.includes('FROM store')) {
        return { rows: state.store ? [state.store] : [], rowCount: state.store ? 1 : 0 };
      }
      if (text.includes('FROM warehouse')) {
        return { rows: state.warehouses, rowCount: state.warehouses.length };
      }
      if (text.includes('FROM product_variant')) {
        return { rows: state.weights, rowCount: state.weights.length };
      }
      throw new Error(`unexpected statement: ${text}`);
    },
  };
  return { tx: tx as unknown as PricingContext['tx'], seen };
}

const ctxWith = (
  state: StubState,
  over: Partial<PricingContext> = {},
): { ctx: PricingContext; seen: string[] } => {
  const { tx, seen } = stubTx(state);
  return {
    ctx: {
      tx,
      organizationId: ORG,
      storeId: STORE,
      salesChannelId: CHANNEL,
      currency: 'EUR',
      country: 'NL',
      shippingAddress: {
        first_name: 'Ada',
        last_name: 'Lovelace',
        line1: 'Keizersgracht 1',
        city: 'Amsterdam',
        postal_code: '1015 CJ',
        country: 'NL',
      },
      lines: [
        {
          lineItemId: 'line-1',
          variantId: '44444444-4444-4444-4444-444444444444',
          productId: 'prod-1',
          categoryId: null,
          quantity: 2,
          unitPriceMinor: 2500,
          discountMinor: 0,
        },
      ],
      ...over,
    } as PricingContext,
    seen,
  };
};

const baseState = (over: Partial<StubState> = {}): StubState => ({
  options: [option()],
  store: { code: 'brand-a', settings: { shipping: { provider: 'manual' } } },
  warehouses: [WAREHOUSE],
  weights: [{ id: '44444444-4444-4444-4444-444444444444', weight_g: 600 }],
  ...over,
});

describe('parseRules', () => {
  it('reads the documented keys and ignores anything unreadable', () => {
    expect(
      parseRules({
        min_subtotal_minor: 1000,
        max_weight_g: 5000,
        free_over_subtotal_minor: 7500,
        live: true,
      }),
    ).toEqual({
      minSubtotalMinor: 1000,
      maxWeightG: 5000,
      freeOverSubtotalMinor: 7500,
      live: true,
    });
    expect(parseRules({ min_subtotal_minor: '1000', max_weight_g: -5, live: 'yes' })).toEqual({
      minSubtotalMinor: null,
      maxWeightG: null,
      freeOverSubtotalMinor: null,
      live: false,
    });
    expect(parseRules(null)).toEqual({
      minSubtotalMinor: null,
      maxWeightG: null,
      freeOverSubtotalMinor: null,
      live: false,
    });
  });
});

describe('rate shopping', () => {
  beforeEach(() => resetCarrierProviders());

  it('prices a table-only option flat and never calls a carrier', async () => {
    const state = baseState();
    const { ctx, seen } = ctxWith(state);
    const rates = await createCarrierRateProvider().list(ctx);
    expect(rates).toEqual([
      {
        optionId: 'opt-std',
        code: 'std',
        name: 'Standard',
        carrier: 'manual',
        priceMinor: 590,
        currency: 'EUR',
      },
    ]);
    // No store, warehouse or variant lookup happens when nothing asks for a live rate.
    expect(seen.some((sql) => sql.includes('FROM warehouse'))).toBe(false);
  });

  it('prices a live option from the carrier and keeps the row identity', async () => {
    const state = baseState({
      options: [
        option({
          code: 'exp',
          name: 'Express',
          carrier: 'manual',
          service: 'manual_express',
          price_minor: '1999',
          rules: { live: true },
        }),
      ],
    });
    const { ctx } = ctxWith(state);
    const rates = await createCarrierRateProvider().list(ctx);
    // 1200 g → 2 started kg → 1290 + 2×200 = 1690, not the row's flat 1999.
    expect(rates).toEqual([
      {
        optionId: 'opt-exp',
        code: 'exp',
        name: 'Express',
        carrier: 'manual',
        priceMinor: 1690,
        currency: 'EUR',
      },
    ]);
  });

  it('falls back to the flat table price when the carrier is down', async () => {
    const down: CarrierProvider = {
      name: 'easypost',
      rates: async () => {
        throw new CarrierError('easypost', 503, 'rates', 'service unavailable', true);
      },
      buyLabel: async () => {
        throw new Error('unused');
      },
      voidLabel: async () => {
        throw new Error('unused');
      },
      track: async () => [],
    };
    setCarrierProvider(down);
    const state = baseState({
      store: { code: 'brand-a', settings: { shipping: { provider: 'easypost' } } },
      options: [
        option({ code: 'exp', service: 'Express', price_minor: '1999', rules: { live: true } }),
      ],
    });
    const { ctx } = ctxWith(state);
    const onFallback = vi.fn();
    const rates = await createCarrierRateProvider({ onFallback }).list(ctx);
    expect(rates[0]!.priceMinor).toBe(1999);
    expect(onFallback).toHaveBeenCalledWith({
      store_id: STORE,
      country: 'NL',
      provider: 'easypost',
      status: 503,
      operation: 'rates',
      reason: 'carrier unavailable, using table rates',
    });
    // The report carries no address.
    expect(JSON.stringify(onFallback.mock.calls[0])).not.toContain('Keizersgracht');
  });

  it('falls back when the store has no credentials for its configured provider', async () => {
    const state = baseState({
      store: { code: 'brand-a', settings: { shipping: { provider: 'easypost' } } },
      options: [option({ service: 'Express', rules: { live: true } })],
    });
    const { ctx } = ctxWith(state);
    const rates = await createCarrierRateProvider({ env: {} }).list(ctx);
    expect(rates[0]!.priceMinor).toBe(590);
  });

  it('falls back when there is no warehouse to ship from', async () => {
    const state = baseState({
      warehouses: [{ address: { city: 'Rotterdam' }, country: 'NL' }],
      options: [option({ service: 'manual_express', carrier: 'manual', rules: { live: true } })],
    });
    const { ctx } = ctxWith(state);
    const onFallback = vi.fn();
    const rates = await createCarrierRateProvider({ onFallback }).list(ctx);
    expect(rates[0]!.priceMinor).toBe(590);
    expect(onFallback.mock.calls[0]![0]).toMatchObject({ operation: 'origin' });
  });

  it('falls back when the cart has no shipping address yet', async () => {
    const state = baseState({
      options: [option({ service: 'manual_express', rules: { live: true } })],
    });
    const { ctx } = ctxWith(state, { shippingAddress: null });
    const rates = await createCarrierRateProvider().list(ctx);
    expect(rates[0]!.priceMinor).toBe(590);
  });

  it('keeps the flat price when the carrier quotes no matching service', async () => {
    const state = baseState({
      options: [option({ service: 'no_such_service', rules: { live: true } })],
    });
    const { ctx } = ctxWith(state);
    const rates = await createCarrierRateProvider().list(ctx);
    expect(rates[0]!.priceMinor).toBe(590);
  });

  it('rejects a carrier rate in another currency than the cart', async () => {
    const wrongCurrency: CarrierProvider = {
      name: 'manual',
      rates: async () => [
        {
          provider: 'manual',
          rateId: 'r1',
          carrier: 'manual',
          service: 'manual_express',
          serviceName: 'Express',
          priceMinor: 100,
          currency: 'USD',
          estimatedDays: 1,
        },
      ],
      buyLabel: async () => {
        throw new Error('unused');
      },
      voidLabel: async () => {
        throw new Error('unused');
      },
      track: async () => [],
    };
    setCarrierProvider(wrongCurrency);
    const state = baseState({
      options: [option({ service: 'manual_express', rules: { live: true } })],
    });
    const { ctx } = ctxWith(state);
    const rates = await createCarrierRateProvider().list(ctx);
    expect(rates[0]!.priceMinor).toBe(590);
    expect(rates[0]!.currency).toBe('EUR');
  });

  it('applies the free-over-threshold rule after pricing', async () => {
    const state = baseState({
      options: [
        option({ code: 'std', rules: { free_over_subtotal_minor: 5000 } }),
        option({ code: 'exp', price_minor: '1290', rules: { free_over_subtotal_minor: 999_999 } }),
      ],
    });
    const { ctx } = ctxWith(state); // subtotal 2 × 2500 = 5000
    const rates = await createCarrierRateProvider().list(ctx);
    expect(rates.map((rate) => [rate.code, rate.priceMinor])).toEqual([
      ['std', 0],
      ['exp', 1290],
    ]);
  });

  it('hides an option below its minimum subtotal or above its maximum weight', async () => {
    const state = baseState({
      options: [
        option({ code: 'std' }),
        option({ code: 'big', rules: { min_subtotal_minor: 10_000 } }),
        option({ code: 'light', rules: { max_weight_g: 1000 } }),
      ],
    });
    const { ctx } = ctxWith(state); // subtotal 5000, weight 2 × 600 = 1200 g
    const rates = await createCarrierRateProvider().list(ctx);
    expect(rates.map((rate) => rate.code)).toEqual(['std']);
  });

  it('counts a variant without a weight as the fallback weight', async () => {
    const state = baseState({
      weights: [],
      options: [option({ code: 'light', rules: { max_weight_g: 999 } })],
    });
    const { ctx } = ctxWith(state); // 2 × 500 g fallback = 1000 g > 999
    expect(await createCarrierRateProvider().list(ctx)).toEqual([]);
    const { ctx: ctx2 } = ctxWith(baseState({ weights: [], options: state.options }));
    const rates = await createCarrierRateProvider({ fallbackLineWeightG: 400 }).list(ctx2);
    expect(rates.map((rate) => rate.code)).toEqual(['light']); // 800 g ≤ 999
  });

  it('sorts by price then code', async () => {
    const state = baseState({
      options: [
        option({ code: 'b', price_minor: '1000' }),
        option({ code: 'a', price_minor: '1000' }),
        option({ code: 'cheap', price_minor: '100' }),
      ],
    });
    const { ctx } = ctxWith(state);
    const rates = await createCarrierRateProvider().list(ctx);
    expect(rates.map((rate) => rate.code)).toEqual(['cheap', 'a', 'b']);
  });

  it('caches a carrier quote per cart and re-shops once it expires', async () => {
    let clock = 1_000;
    const carrier = createManualCarrierProvider(undefined, 'easypost');
    const spy = vi.spyOn(carrier, 'rates');
    setCarrierProvider(carrier);
    const options = [
      option({ code: 'exp', service: 'manual_express', carrier: 'manual', rules: { live: true } }),
    ];
    const store = { code: 'brand-a', settings: { shipping: { provider: 'easypost' } } };
    const provider = createCarrierRateProvider({
      env: { EASYPOST_API_KEY: 'EZTKtest' },
      now: () => clock,
      cacheTtlMs: 60_000,
    });
    // A provider registered at boot wins over building one from the store's credentials.
    const first = await provider.list(ctxWith(baseState({ options, store })).ctx);
    const second = await provider.list(ctxWith(baseState({ options, store })).ctx);
    expect(second).toEqual(first);
    expect(spy).toHaveBeenCalledTimes(1);

    clock += 61_000;
    await provider.list(ctxWith(baseState({ options, store })).ctx);
    expect(spy).toHaveBeenCalledTimes(2);

    // A different destination is a different key.
    const elsewhere = ctxWith(baseState({ options, store }), {
      shippingAddress: {
        first_name: 'Ada',
        last_name: 'Lovelace',
        line1: 'Another street 9',
        city: 'Utrecht',
        postal_code: '3511 AA',
        country: 'NL',
      },
    }).ctx;
    await provider.list(elsewhere);
    expect(spy).toHaveBeenCalledTimes(3);

    provider.clearCache();
    await provider.list(ctxWith(baseState({ options, store })).ctx);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('quotes one option and returns null for an unknown or ineligible one', async () => {
    const state = baseState({
      options: [
        option({ code: 'std' }),
        option({ code: 'big', rules: { min_subtotal_minor: 10_000 } }),
      ],
    });
    const provider = createCarrierRateProvider();
    expect(await provider.quote(ctxWith(state).ctx, 'opt-std')).toMatchObject({
      optionId: 'opt-std',
      priceMinor: 590,
    });
    expect(await provider.quote(ctxWith(state).ctx, 'opt-big')).toBeNull();
    expect(await provider.quote(ctxWith(state).ctx, 'opt-missing')).toBeNull();
  });

  it('offers nothing when the store row has vanished but still never throws', async () => {
    const state = baseState({
      store: null,
      options: [option({ service: 'manual_express', rules: { live: true } })],
    });
    const { ctx } = ctxWith(state);
    const rates = await createCarrierRateProvider().list(ctx);
    expect(rates[0]!.priceMinor).toBe(590);
  });
});
