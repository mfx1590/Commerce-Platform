// Tax module (issue #127) on a seeded throwaway database + FakeStripe: the table provider for the three seeded
// markets (EU/NL 21 %, UK/GB 20 %, US/NY 8.88 %) in tax-exclusive and tax-inclusive mode from store settings,
// taxable shipping, parity with the cart's built-in calculator under default settings; the Stripe Tax provider
// (request shape without PII, result mapping, basis points, shipping tax, fail-closed without a key, refusals);
// outages fail closed unless the explicit non-production opt-in is set; and the calculator registered with the
// cart module end to end.
import { randomUUID } from 'node:crypto';
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addLineItem,
  createCart,
  setTaxCalculator,
  tableTaxCalculator,
  taxOn,
  type TaxCalculation,
} from '../cart';
import { FakeStripe, StripeError } from '../payments';
import {
  createTaxCalculator,
  DEFAULT_TAX_SETTINGS,
  rateBpOf,
  registerTaxProvider,
  TAX_FALLBACK_FLAG,
  taxFallbackEnabled,
  taxFor,
  taxSettingsFrom,
  type TaxContext,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA; // NL / EUR / VAT 21 %
const B = SEED_IDS.stores.brandB; // GB / GBP / VAT 20 %
const C = SEED_IDS.stores.brandC; // US / USD / NY sales tax 8.88 % (region NY)
const env = { STRIPE_SECRET_KEY: 'sk_test_fake_global' } as NodeJS.ProcessEnv;

let db: TestDatabase;
let owner: ReturnType<typeof createOrganizationClient>;
const clients = new Map<string, ReturnType<typeof createTenantClient>>();
let fake: FakeStripe;

beforeAll(async () => {
  db = await createTestDatabase('core_tax');
  await seed(db.owner, { log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  for (const s of [A, B, C]) {
    clients.set(s, createTenantClient(db.app, { organizationId: ORG, storeIds: [s] }));
  }
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

beforeEach(() => {
  fake = new FakeStripe();
});

afterEach(async () => {
  setTaxCalculator(tableTaxCalculator);
  await owner.query(`UPDATE store SET settings = settings - 'tax'`);
});

async function setTax(storeId: string, tax: Record<string, unknown>): Promise<void> {
  await owner.query(
    `UPDATE store SET settings = jsonb_set(settings, '{tax}', $2::jsonb) WHERE id = $1`,
    [storeId, JSON.stringify(tax)],
  );
}

interface Line {
  id: string;
  quantity: number;
  unit: number;
  discount?: number;
}

/** Runs `calculate` inside a transaction of the store's tenant client (what the cart does). */
function priced(
  storeId: string,
  o: {
    currency: string;
    country: string;
    region?: string | null;
    lines: Line[];
    shippingMinor?: number;
    calculator?: ReturnType<typeof createTaxCalculator>;
  },
): Promise<TaxCalculation> {
  const calculator =
    o.calculator ?? createTaxCalculator({ apiFactory: () => fake, env, log: () => {} });
  return clients.get(storeId)!.transaction((tx) => {
    const ctx: TaxContext = {
      tx,
      organizationId: ORG,
      storeId,
      salesChannelId: randomUUID(),
      currency: o.currency,
      country: o.country,
      shippingAddress: {
        first_name: 'Jane',
        last_name: 'Doe',
        line1: 'Secret Street 1',
        city: 'Amsterdam',
        postal_code: '1015 CJ',
        country: o.country,
        region: o.region ?? null,
        phone: '+31 6 1234 5678',
      },
      lines: o.lines.map((l) => ({
        lineItemId: l.id,
        variantId: randomUUID(),
        productId: randomUUID(),
        categoryId: null,
        quantity: l.quantity,
        unitPriceMinor: l.unit,
        discountMinor: l.discount ?? 0,
      })),
      shippingMinor: o.shippingMinor ?? 0,
    };
    return calculator.calculate(ctx);
  });
}

// ---------------------------------------------------------------------------------------------- arithmetic

describe('rounding and settings', () => {
  it("one rounding seam: taxFor IS the cart module's taxOn in both modes, ties included", () => {
    expect(taxFor(12100, 2100, true)).toBe(2100);
    expect(taxFor(100, 2100, true)).toBe(17); // 100 × 2100 / 12100 = 17.36
    expect(taxFor(1999, 2000, true)).toBe(333); // 333.17
    expect(taxFor(10000, 888, true)).toBe(816); // 815.58
    expect(taxFor(9, 2000, true)).toBe(2); // 1.5 → the TAX rounds half-up (core #224), not the net
    expect(taxFor(0, 2100, true)).toBe(0);
    expect(taxFor(500, 0, true)).toBe(0);
    expect(taxFor(2000, 2100, false)).toBe(420);
    expect(taxFor(2000, 2100, true)).toBe(347);
    for (const bp of [888, 2000, 2100, 2500]) {
      for (let amount = 1; amount <= 3000; amount += 7) {
        for (const included of [false, true]) {
          expect(taxFor(amount, bp, included)).toBe(taxOn(amount, bp, included));
          expect(Number.isInteger(taxFor(amount, bp, included))).toBe(true);
        }
      }
    }
  });

  it('store.settings.tax: defaults, malformed input never throws, known values are read', () => {
    expect(taxSettingsFrom(undefined)).toEqual(DEFAULT_TAX_SETTINGS);
    expect(taxSettingsFrom({ tax: 'yes' })).toEqual(DEFAULT_TAX_SETTINGS);
    expect(taxSettingsFrom({ tax: { provider: 'avalara', prices_include_tax: 'true' } })).toEqual(
      DEFAULT_TAX_SETTINGS,
    );
    expect(
      taxSettingsFrom({
        tax: { provider: 'stripe', prices_include_tax: true, shipping_taxable: true },
      }),
    ).toEqual({ provider: 'stripe', pricesIncludeTax: true, shippingTaxable: true });
  });

  it('the table fallback flag: only the exact opt-in outside production; production refuses the flag itself', () => {
    expect(taxFallbackEnabled({})).toBe(false);
    expect(taxFallbackEnabled({ [TAX_FALLBACK_FLAG]: 'true' })).toBe(false);
    expect(taxFallbackEnabled({ [TAX_FALLBACK_FLAG]: '1' })).toBe(true);
    expect(taxFallbackEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(() => taxFallbackEnabled({ NODE_ENV: 'production', [TAX_FALLBACK_FLAG]: '1' })).toThrow(
      /must not be set in production/,
    );
    expect(() =>
      createTaxCalculator({
        env: { NODE_ENV: 'production', [TAX_FALLBACK_FLAG]: '0' } as NodeJS.ProcessEnv,
      }),
    ).toThrow(/must not be set in production/); // refused at registration (boot), whatever its value
  });

  it('basis points of a Stripe Tax line: sum of the breakdown, else derived from the amounts', () => {
    const base = {
      reference: 'l',
      amount: 10000,
      amount_tax: 888,
      tax_behavior: 'exclusive' as const,
    };
    expect(
      rateBpOf({
        ...base,
        tax_breakdown: [
          { amount: 400, tax_rate_details: { percentage_decimal: '4.0' } },
          { amount: 488, tax_rate_details: { percentage_decimal: '4.875' } },
        ],
      }),
    ).toBe(888); // 8.875 % → 887.5 → 888 bp
    expect(rateBpOf(base)).toBe(888);
    expect(rateBpOf({ ...base, amount: 12100, amount_tax: 2100, tax_behavior: 'inclusive' })).toBe(
      2100,
    );
    expect(rateBpOf({ ...base, amount_tax: 0 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------- table provider

describe('table provider — the three seeded markets', () => {
  const l1 = randomUUID();
  const l2 = randomUUID();

  it('EU (NL 21 %): exclusive adds on top, inclusive extracts; default settings equal the cart built-in', async () => {
    const lines: Line[] = [
      { id: l1, quantity: 2, unit: 1000 },
      { id: l2, quantity: 1, unit: 4999, discount: 500 },
    ];
    const exclusive = await priced(A, {
      currency: 'EUR',
      country: 'NL',
      lines,
      shippingMinor: 500,
    });
    expect(exclusive).toEqual({
      lines: [
        { lineItemId: l1, taxRateBp: 2100, taxMinor: 420 },
        { lineItemId: l2, taxRateBp: 2100, taxMinor: taxOn(4499, 2100) },
      ],
      shippingTaxMinor: 0,
    });
    // Parity: with default settings the registered calculator IS the cart's table calculator.
    const builtIn = await priced(A, {
      currency: 'EUR',
      country: 'NL',
      lines,
      shippingMinor: 500,
      calculator: tableTaxCalculator,
    });
    expect(exclusive).toEqual(builtIn);

    await setTax(A, { prices_include_tax: true });
    const inclusive = await priced(A, {
      currency: 'EUR',
      country: 'NL',
      lines,
      shippingMinor: 500,
    });
    expect(inclusive.lines).toEqual([
      { lineItemId: l1, taxRateBp: 2100, taxMinor: 347 },
      { lineItemId: l2, taxRateBp: 2100, taxMinor: taxOn(4499, 2100, true) },
    ]);
    expect(inclusive.shippingTaxMinor).toBe(0);
  });

  it('UK (GB 20 %): both modes; taxable shipping uses the store-wide rate in the same mode', async () => {
    const lines: Line[] = [{ id: l1, quantity: 1, unit: 1999 }];
    expect(await priced(B, { currency: 'GBP', country: 'GB', lines })).toEqual({
      lines: [{ lineItemId: l1, taxRateBp: 2000, taxMinor: 400 }],
      shippingTaxMinor: 0,
    });
    await setTax(B, { shipping_taxable: true });
    expect(
      (await priced(B, { currency: 'GBP', country: 'GB', lines, shippingMinor: 495 }))
        .shippingTaxMinor,
    ).toBe(99);
    await setTax(B, { shipping_taxable: true, prices_include_tax: true });
    const inclusive = await priced(B, {
      currency: 'GBP',
      country: 'GB',
      lines,
      shippingMinor: 495,
    });
    expect(inclusive.lines[0]).toEqual({ lineItemId: l1, taxRateBp: 2000, taxMinor: 333 });
    expect(inclusive.shippingTaxMinor).toBe(taxOn(495, 2000, true));
  });

  it('US (NY 8.88 %): the region decides; another state or country is untaxed, not an error', async () => {
    const lines: Line[] = [{ id: l1, quantity: 1, unit: 10000 }];
    expect(await priced(C, { currency: 'USD', country: 'US', region: 'NY', lines })).toEqual({
      lines: [{ lineItemId: l1, taxRateBp: 888, taxMinor: 888 }],
      shippingTaxMinor: 0,
    });
    expect(
      (await priced(C, { currency: 'USD', country: 'US', region: 'CA', lines })).lines[0],
    ).toEqual({
      lineItemId: l1,
      taxRateBp: 0,
      taxMinor: 0,
    });
    expect((await priced(C, { currency: 'USD', country: 'CA', lines })).lines[0]!.taxMinor).toBe(0);
    await setTax(C, { prices_include_tax: true });
    expect(
      (await priced(C, { currency: 'USD', country: 'US', region: 'NY', lines })).lines[0],
    ).toEqual({ lineItemId: l1, taxRateBp: 888, taxMinor: 816 });
  });

  it('every amount is an integer and an empty cart is empty', async () => {
    expect(await priced(A, { currency: 'EUR', country: 'NL', lines: [] })).toEqual({
      lines: [],
      shippingTaxMinor: 0,
    });
    const r = await priced(A, {
      currency: 'EUR',
      country: 'NL',
      lines: [{ id: l1, quantity: 3, unit: 333, discount: 1 }],
    });
    expect(Number.isInteger(r.lines[0]!.taxMinor)).toBe(true);
    expect(r.lines[0]!.taxMinor).toBe(taxOn(998, 2100));
  });
});

// ---------------------------------------------------------------------------------------------- stripe provider

describe('Stripe Tax provider (FakeStripe)', () => {
  const l1 = randomUUID();
  const l2 = randomUUID();
  const free = randomUUID();

  it('sends amounts, ids and the destination only; maps line tax, basis points and shipping tax', async () => {
    await setTax(A, { provider: 'stripe' });
    fake.taxRateBp = 2100;
    const r = await priced(A, {
      currency: 'EUR',
      country: 'NL',
      lines: [
        { id: l1, quantity: 2, unit: 1000 },
        { id: l2, quantity: 1, unit: 4999, discount: 500 },
        { id: free, quantity: 1, unit: 500, discount: 500 },
      ],
      shippingMinor: 500,
    });
    expect(r).toEqual({
      lines: [
        { lineItemId: l1, taxRateBp: 2100, taxMinor: 420 },
        { lineItemId: l2, taxRateBp: 2100, taxMinor: 945 },
        { lineItemId: free, taxRateBp: 0, taxMinor: 0 }, // nothing to tax: never sent
      ],
      shippingTaxMinor: 105,
    });
    const call = fake.callsOf('createTaxCalculation')[0]!;
    expect(call.expand).toEqual(['line_items']);
    expect(call.params).toEqual({
      currency: 'eur',
      line_items: [
        { amount: 2000, reference: l1, tax_behavior: 'exclusive' },
        { amount: 4499, reference: l2, tax_behavior: 'exclusive' },
      ],
      shipping_cost: { amount: 500, tax_behavior: 'exclusive' },
      customer_details: {
        address: { country: 'NL', postal_code: '1015 CJ', city: 'Amsterdam' },
        address_source: 'shipping',
      },
    });
    // No name, street, phone or email ever leaves the process.
    expect(JSON.stringify(call.params)).not.toMatch(/Jane|Doe|Secret Street|\+31|@/);
  });

  it('inclusive stores ask Stripe for inclusive tax; a region travels as `state`', async () => {
    await setTax(C, { provider: 'stripe', prices_include_tax: true });
    fake.taxRateBp = 888;
    const r = await priced(C, {
      currency: 'USD',
      country: 'US',
      region: 'NY',
      lines: [{ id: l1, quantity: 1, unit: 10000 }],
    });
    expect(r.lines[0]).toEqual({ lineItemId: l1, taxRateBp: 888, taxMinor: 816 });
    const params = fake.callsOf('createTaxCalculation')[0]!.params as {
      line_items: { tax_behavior: string }[];
      customer_details: { address: Record<string, string> };
    };
    expect(params.line_items[0]!.tax_behavior).toBe('inclusive');
    expect(params.customer_details.address.state).toBe('NY');
  });

  it('fails closed: no key → 400 naming the variables; a Stripe refusal → 400 with its code; an outage rethrows', async () => {
    await setTax(A, { provider: 'stripe' });
    const lines: Line[] = [{ id: l1, quantity: 1, unit: 1000 }];
    const noKey = createTaxCalculator({ apiFactory: () => fake, env: {} as NodeJS.ProcessEnv });
    await expect(
      priced(A, { currency: 'EUR', country: 'NL', lines, calculator: noKey }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      message: expect.stringContaining('STRIPE_SECRET_KEY_BRAND_A or STRIPE_SECRET_KEY'),
    });
    fake.failNextTax = 'customer_tax_location_invalid';
    await expect(priced(A, { currency: 'EUR', country: 'NL', lines })).rejects.toMatchObject({
      code: 'validation_error',
      details: { provider: 'stripe', feature: 'tax', code: 'customer_tax_location_invalid' },
    });
    fake.outageNextTax = true;
    await expect(priced(A, { currency: 'EUR', country: 'NL', lines })).rejects.toBeInstanceOf(
      StripeError,
    );
  });

  it('outage + the explicit non-production opt-in → table rates, with one log line (ids only); refusals never fall back', async () => {
    await setTax(A, { provider: 'stripe' });
    const lines: Line[] = [{ id: l1, quantity: 1, unit: 1000 }];
    const logged: string[] = [];
    const optIn = createTaxCalculator({
      apiFactory: () => fake,
      env: { ...env, [TAX_FALLBACK_FLAG]: '1' } as NodeJS.ProcessEnv,
      log: (line) => logged.push(line),
    });
    fake.taxRateBp = 900; // what Stripe WOULD have said
    fake.outageNextTax = true;
    const r = await priced(A, { currency: 'EUR', country: 'NL', lines, calculator: optIn });
    expect(r.lines[0]).toEqual({ lineItemId: l1, taxRateBp: 2100, taxMinor: 210 }); // the table's answer
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(A);
    expect(logged[0]).not.toMatch(/Jane|Secret Street/);
    // A definitive refusal is a decision, not an outage: no fallback even with the opt-in.
    fake.failNextTax = 'customer_tax_location_invalid';
    await expect(
      priced(A, { currency: 'EUR', country: 'NL', lines, calculator: optIn }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    // And with Stripe up, the opt-in changes nothing.
    expect(
      (await priced(A, { currency: 'EUR', country: 'NL', lines, calculator: optIn })).lines[0],
    ).toEqual({ lineItemId: l1, taxRateBp: 900, taxMinor: 90 });
  });
});

// ---------------------------------------------------------------------------------------------- cart seam

describe('registered with the cart module', () => {
  it('registerTaxProvider(): default settings price exactly like before; a stripe store is priced by Stripe Tax', async () => {
    const previous = registerTaxProvider({ apiFactory: () => fake, env, log: () => {} });
    expect(previous).toBe(tableTaxCalculator);
    const a = clients.get(A)!;
    const channel = await owner.query<{ id: string }>(
      `SELECT id FROM sales_channel WHERE store_id = $1 AND code = 'web'`,
      [A],
    );
    const variant = await owner.query<{ id: string; price: string }>(
      `SELECT v.id, pr.amount_minor::text AS price
       FROM product_variant v JOIN product p ON p.id = v.product_id AND p.status = 'published'
       JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'EUR' AND pr.min_quantity = 1
       WHERE v.store_id = $1 ORDER BY v.sku LIMIT 1`,
      [A],
    );
    const v = variant.rows[0]!;
    const scope = { organizationId: ORG, storeId: A, salesChannelId: channel.rows[0]!.id };

    const cart = await createCart(a, scope, {});
    const tablePriced = await addLineItem(a, cart.id, { variant_id: v.id, quantity: 2 });
    const base = 2 * Number(v.price);
    expect(tablePriced.totals.tax.amount_minor).toBe(taxOn(base, 2100));
    expect(fake.callsOf('createTaxCalculation')).toHaveLength(0);

    await setTax(A, { provider: 'stripe' });
    fake.taxRateBp = 1000;
    const cart2 = await createCart(a, scope, {});
    const stripePriced = await addLineItem(a, cart2.id, { variant_id: v.id, quantity: 2 });
    expect(stripePriced.totals.tax.amount_minor).toBe(taxOn(base, 1000));
    expect(stripePriced.totals.total.amount_minor).toBe(base + taxOn(base, 1000));
    expect(fake.callsOf('createTaxCalculation').length).toBeGreaterThan(0);
  });
});
