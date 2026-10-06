// Tax module (issue #127) on a seeded throwaway database + FakeStripe: the table provider for the three seeded
// markets (EU/NL 21 %, UK/GB 20 %, US/NY 8.88 %) in tax-exclusive and tax-inclusive mode from store settings,
// delivery VAT at the goods' rate (EU default, pro rata for mixed carts, explicit exemption, #352), parity of the
// lines with the cart's built-in calculator; the Stripe Tax provider
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
  updateCart,
  type TaxCalculation,
} from '../cart';
import { FakeStripe, StripeError } from '../payments';
import {
  allocateProRata,
  createTaxCalculator,
  DEFAULT_TAX_SETTINGS,
  defaultShippingTaxable,
  EU_COUNTRIES,
  rateBpOf,
  shippingTaxAtGoodsRate,
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
  await owner.query(`DELETE FROM tax_rate WHERE name = 'VAT 9% (test)'`);
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
  categoryId?: string | null;
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
        categoryId: l.categoryId ?? null,
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
    ).toEqual({
      provider: 'stripe',
      pricesIncludeTax: true,
      shippingTaxable: true,
      shippingTaxableExplicit: true,
    });
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
      shippingTaxMinor: 105, // #352: an EU store's delivery charge carries VAT at the goods' rate by default
    });
    // Parity: the LINES are exactly the cart's built-in calculator; delivery VAT is the one platform default this
    // module adds (the built-in never taxes shipping).
    const builtIn = await priced(A, {
      currency: 'EUR',
      country: 'NL',
      lines,
      shippingMinor: 500,
      calculator: tableTaxCalculator,
    });
    expect(exclusive.lines).toEqual(builtIn.lines);
    expect(builtIn.shippingTaxMinor).toBe(0);

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
    expect(inclusive.shippingTaxMinor).toBe(taxOn(500, 2100, true)); // contained in the gross delivery price
  });

  it("UK (GB 20 %): not in the EU set → shipping untaxed by default; opt-in taxes it at the goods' rate in the same mode", async () => {
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

// ---------------------------------------------------------------------------------- delivery VAT (#352)

describe("delivery VAT — shipping at the goods' rate (#352)", () => {
  const l1 = randomUUID();
  const l2 = randomUUID();

  it("settings: the shipping_taxable default follows the legal entity's country (EU → taxable), an explicit value wins", () => {
    expect(EU_COUNTRIES.size).toBe(27);
    expect(defaultShippingTaxable('NL')).toBe(true);
    expect(defaultShippingTaxable('nl')).toBe(true);
    expect(defaultShippingTaxable('GB')).toBe(false);
    expect(defaultShippingTaxable('US')).toBe(false);
    expect(defaultShippingTaxable(null)).toBe(false);
    expect(taxSettingsFrom({}, { legalEntityCountry: 'NL' })).toEqual({
      ...DEFAULT_TAX_SETTINGS,
      shippingTaxable: true,
      shippingTaxableExplicit: false,
    });
    expect(
      taxSettingsFrom({ tax: { provider: 'table' } }, { legalEntityCountry: 'DE' }),
    ).toMatchObject({
      shippingTaxable: true,
      shippingTaxableExplicit: false,
    });
    expect(
      taxSettingsFrom({ tax: { shipping_taxable: false } }, { legalEntityCountry: 'NL' }),
    ).toMatchObject({
      shippingTaxable: false,
      shippingTaxableExplicit: true,
    });
    expect(
      taxSettingsFrom({ tax: { shipping_taxable: true } }, { legalEntityCountry: 'US' }),
    ).toMatchObject({
      shippingTaxable: true,
      shippingTaxableExplicit: true,
    });
    expect(
      taxSettingsFrom({ tax: { shipping_taxable: 'yes' } }, { legalEntityCountry: 'US' }),
    ).toMatchObject({
      shippingTaxable: false, // malformed → the country default, never an error
      shippingTaxableExplicit: false,
    });
    expect(taxSettingsFrom(undefined)).toEqual(DEFAULT_TAX_SETTINGS);
  });

  it('allocateProRata: integer shares that add up exactly (largest remainder)', () => {
    expect(allocateProRata(400, [1000, 3000])).toEqual([100, 300]);
    expect(allocateProRata(499, [2000, 1450])).toEqual([289, 210]); // 289.28 / 209.71 → the .71 gets the cent
    expect(allocateProRata(1, [1, 1, 1])).toEqual([1, 0, 0]);
    expect(allocateProRata(10, [0, 0])).toEqual([10, 0]);
    expect(allocateProRata(0, [5, 5])).toEqual([0, 0]);
    for (const [total, w] of [
      [499, [2000, 1450, 333]],
      [1, [7, 9]],
      [12345, [1, 2, 3, 4]],
    ] as [number, number[]][]) {
      const shares = allocateProRata(total, w);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
      expect(shares.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
    }
  });

  it('shippingTaxAtGoodsRate: one rate → that rate; mixed → pro rata per rate; no taxable goods → the fallback rate', () => {
    expect(shippingTaxAtGoodsRate(499, [{ rateBp: 2100, baseMinor: 3450 }], 2100, false)).toBe(105);
    expect(
      shippingTaxAtGoodsRate(
        400,
        [
          { rateBp: 2100, baseMinor: 1000 },
          { rateBp: 900, baseMinor: 3000 },
        ],
        2100,
        false,
      ),
    ).toBe(21 + 27);
    expect(
      shippingTaxAtGoodsRate(
        499,
        [
          { rateBp: 2100, baseMinor: 2000 },
          { rateBp: 900, baseMinor: 1450 },
          { rateBp: 2100, baseMinor: 0 }, // a free line carries no weight
        ],
        2100,
        false,
      ),
    ).toBe(taxOn(289, 2100) + taxOn(210, 900)); // 61 + 19 = 80
    expect(shippingTaxAtGoodsRate(499, [{ rateBp: 2100, baseMinor: 0 }], 2100, false)).toBe(105);
    expect(shippingTaxAtGoodsRate(499, [], 0, false)).toBe(0);
    expect(shippingTaxAtGoodsRate(0, [{ rateBp: 2100, baseMinor: 100 }], 2100, false)).toBe(0);
    // inclusive: the tax contained in the gross delivery price, per share
    expect(
      shippingTaxAtGoodsRate(
        400,
        [
          { rateBp: 2100, baseMinor: 1000 },
          { rateBp: 900, baseMinor: 3000 },
        ],
        2100,
        true,
      ),
    ).toBe(taxOn(100, 2100, true) + taxOn(300, 900, true));
  });

  it("the manager's walk-through (NL, €34.50 goods, €4.99 delivery): tax €7.25 + €1.05, total €47.79", async () => {
    const r = await priced(A, {
      currency: 'EUR',
      country: 'NL',
      lines: [{ id: l1, quantity: 1, unit: 3450 }],
      shippingMinor: 499,
    });
    expect(r).toEqual({
      lines: [{ lineItemId: l1, taxRateBp: 2100, taxMinor: 725 }],
      shippingTaxMinor: 105,
    });
    expect(3450 + 499 + 725 + 105).toBe(4779);
  });

  it("a mixed-rate NL cart apportions the delivery charge to the goods' rates (table provider)", async () => {
    const cat = await owner.query<{ id: string }>(
      `SELECT id FROM product_category WHERE store_id = $1 ORDER BY id LIMIT 1`,
      [A],
    );
    const categoryId = cat.rows[0]!.id;
    await owner.query(
      `INSERT INTO tax_rate (organization_id, store_id, country, region, name, rate_bp, product_category_id)
       VALUES ($1, $2, 'NL', NULL, 'VAT 9% (test)', 900, $3)`,
      [ORG, A, categoryId],
    );
    const r = await priced(A, {
      currency: 'EUR',
      country: 'NL',
      lines: [
        { id: l1, quantity: 2, unit: 1000 }, // 2000 at 21 %
        { id: l2, quantity: 1, unit: 1450, categoryId }, // 1450 at 9 %
      ],
      shippingMinor: 499,
    });
    expect(r.lines).toEqual([
      { lineItemId: l1, taxRateBp: 2100, taxMinor: 420 },
      { lineItemId: l2, taxRateBp: 900, taxMinor: taxOn(1450, 900) },
    ]);
    expect(r.shippingTaxMinor).toBe(taxOn(289, 2100) + taxOn(210, 900)); // 80
    // Only reduced-rate goods → the whole charge at 9 %.
    const reducedOnly = await priced(A, {
      currency: 'EUR',
      country: 'NL',
      lines: [{ id: l2, quantity: 1, unit: 1450, categoryId }],
      shippingMinor: 499,
    });
    expect(reducedOnly.shippingTaxMinor).toBe(taxOn(499, 900));
  });

  it("a store configured shipping-exempt keeps today's behaviour; a non-EU store is untaxed by default and can opt in", async () => {
    const lines: Line[] = [{ id: l1, quantity: 1, unit: 3450 }];
    await setTax(A, { shipping_taxable: false });
    const exempt = await priced(A, { currency: 'EUR', country: 'NL', lines, shippingMinor: 499 });
    expect(exempt).toEqual({
      lines: [{ lineItemId: l1, taxRateBp: 2100, taxMinor: 725 }],
      shippingTaxMinor: 0,
    });
    expect(exempt).toEqual(
      await priced(A, {
        currency: 'EUR',
        country: 'NL',
        lines,
        shippingMinor: 499,
        calculator: tableTaxCalculator,
      }),
    );
    // US store (legal entity US): untaxed by default, taxed at the destination's rate on opt-in.
    const us: Line[] = [{ id: l1, quantity: 1, unit: 10000 }];
    expect(
      (
        await priced(C, {
          currency: 'USD',
          country: 'US',
          region: 'NY',
          lines: us,
          shippingMinor: 1000,
        })
      ).shippingTaxMinor,
    ).toBe(0);
    await setTax(C, { shipping_taxable: true });
    expect(
      (
        await priced(C, {
          currency: 'USD',
          country: 'US',
          region: 'NY',
          lines: us,
          shippingMinor: 1000,
        })
      ).shippingTaxMinor,
    ).toBe(89); // 8.88 % of 10.00
    // An EU store shipping to an untaxed destination: no rate → no delivery tax either (not an error).
    expect(
      (await priced(A, { currency: 'EUR', country: 'CH', lines, shippingMinor: 499 }))
        .shippingTaxMinor,
    ).toBe(0);
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

  it('an explicit shipping_taxable: false keeps the delivery charge out of the Stripe Tax calculation; the default lets Stripe decide', async () => {
    await setTax(A, { provider: 'stripe', shipping_taxable: false });
    fake.taxRateBp = 2100;
    const exempt = await priced(A, {
      currency: 'EUR',
      country: 'NL',
      lines: [{ id: l1, quantity: 1, unit: 3450 }],
      shippingMinor: 499,
    });
    expect(exempt.shippingTaxMinor).toBe(0);
    expect(fake.callsOf('createTaxCalculation')[0]!.params).not.toHaveProperty('shipping_cost');
    await setTax(A, { provider: 'stripe' });
    const decided = await priced(A, {
      currency: 'EUR',
      country: 'NL',
      lines: [{ id: l1, quantity: 1, unit: 3450 }],
      shippingMinor: 499,
    });
    expect(decided.shippingTaxMinor).toBe(105);
    expect(fake.callsOf('createTaxCalculation')[1]!.params).toMatchObject({
      shipping_cost: { amount: 499, tax_behavior: 'exclusive' },
    });
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

  it('checkout totals (#352): an NL cart with €4.99 delivery shows VAT on the delivery; a shipping-exempt store does not', async () => {
    registerTaxProvider({ apiFactory: () => fake, env, log: () => {} });
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
    const option = await owner.query<{ id: string; price_minor: string }>(
      `SELECT id, price_minor::text FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
      [A],
    );
    const v = variant.rows[0]!;
    const shipping = Number(option.rows[0]!.price_minor);
    expect(shipping).toBe(499);
    const scope = { organizationId: ORG, storeId: A, salesChannelId: channel.rows[0]!.id };
    const address = {
      first_name: 'Jane',
      last_name: 'Doe',
      line1: 'Keizersgracht 1',
      city: 'Amsterdam',
      postal_code: '1015 CJ',
      country: 'NL',
    };

    const cart = await createCart(a, scope, {});
    await addLineItem(a, cart.id, { variant_id: v.id, quantity: 1 });
    const priced1 = await updateCart(a, cart.id, {
      shipping_address: address,
      shipping_option_id: option.rows[0]!.id,
    });
    const base = Number(v.price);
    const goodsTax = taxOn(base, 2100);
    const deliveryTax = taxOn(shipping, 2100); // 105
    expect(priced1.totals.shipping.amount_minor).toBe(shipping);
    expect(priced1.totals.tax.amount_minor).toBe(goodsTax + deliveryTax);
    expect(priced1.totals.total.amount_minor).toBe(base + shipping + goodsTax + deliveryTax);

    await setTax(A, { shipping_taxable: false });
    const cart2 = await createCart(a, scope, {});
    await addLineItem(a, cart2.id, { variant_id: v.id, quantity: 1 });
    const priced2 = await updateCart(a, cart2.id, {
      shipping_address: address,
      shipping_option_id: option.rows[0]!.id,
    });
    expect(priced2.totals.tax.amount_minor).toBe(goodsTax);
    expect(priced2.totals.total.amount_minor).toBe(base + shipping + goodsTax);
  });
});
