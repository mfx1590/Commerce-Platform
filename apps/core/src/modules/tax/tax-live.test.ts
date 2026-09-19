// Live Stripe Tax (test mode). Skips without STRIPE_SECRET_KEY (never committed; repo-root .env locally).
// Asserts the SHAPE the provider relies on — integer minor units per line, the reference round trip, the
// breakdown percentages — not a particular rate: what a test account collects depends on its tax registrations
// (an account without an NL registration answers 0 with `taxability_reason: not_collecting`).
import { describe, expect, it } from 'vitest';
import { formEncode, StripeClient } from '../payments';
import { rateBpOf } from './index';

const key = process.env.STRIPE_SECRET_KEY;

describe('form encoding of a tax calculation', () => {
  it('arrays of objects are indexed the way Stripe expects', () => {
    expect(
      decodeURIComponent(
        formEncode({
          currency: 'eur',
          line_items: [{ amount: 1000, reference: 'l1', tax_behavior: 'exclusive' }],
          customer_details: { address: { country: 'NL' }, address_source: 'shipping' },
        }),
      ),
    ).toBe(
      'currency=eur&line_items[0][amount]=1000&line_items[0][reference]=l1' +
        '&line_items[0][tax_behavior]=exclusive&customer_details[address][country]=NL' +
        '&customer_details[address_source]=shipping',
    );
  });
});

describe.skipIf(!key || !key.startsWith('sk_test_'))('Stripe Tax — live, test mode', () => {
  it('calculates per line in integer minor units and echoes our references', async () => {
    const client = new StripeClient({ secretKey: key! });
    const calc = await client.createTaxCalculation(
      {
        currency: 'eur',
        line_items: [
          { amount: 2000, reference: 'line-1', tax_behavior: 'exclusive' },
          { amount: 4499, reference: 'line-2', tax_behavior: 'exclusive' },
        ],
        shipping_cost: { amount: 500, tax_behavior: 'exclusive' },
        customer_details: {
          address: { country: 'NL', postal_code: '1015 CJ', city: 'Amsterdam' },
          address_source: 'shipping',
        },
      },
      { expand: ['line_items'] },
    );
    expect(calc.object).toBe('tax.calculation');
    expect(calc.currency).toBe('eur');
    const lines = calc.line_items?.data ?? [];
    expect(lines.map((l) => l.reference).sort()).toEqual(['line-1', 'line-2']);
    for (const l of lines) {
      expect(Number.isInteger(l.amount_tax)).toBe(true);
      expect(l.amount_tax).toBeGreaterThanOrEqual(0);
      const bp = rateBpOf(l);
      expect(Number.isInteger(bp)).toBe(true);
      if (l.amount_tax > 0) expect(bp).toBe(2100); // NL standard rate when the account collects there
    }
    expect(Number.isInteger(calc.shipping_cost?.amount_tax ?? 0)).toBe(true);
  }, 30_000);
});
