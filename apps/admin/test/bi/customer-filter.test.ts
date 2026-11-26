// Admin API 0.4.31 (#951 re-review): an answer cut by customer type rests on customers, and the API refuses to
// combine it with a product or category cut (400 small_cell_unverifiable: small groups could not be protected).
//   * the customer filter is sent ONLY when the user chose it (the default views never carry it);
//   * a view the API would refuse is not sent, and the page says why in words (SMALL_CELL_REFUSAL), never a 400 panel;
//   * the breakdowns the API can count in customers (store, country, sales channel) still carry the filter.
import { describe, expect, it } from 'vitest';
import { filtersOf, parseState } from '@/app/(hq)/bi/_v2/model';
import {
  breakdownQuery,
  categoriesQuery,
  customerFilterRefused,
  moversQuery,
  overviewQueries,
  productsQuery,
  SMALL_CELL_REFUSAL,
} from '@/app/(hq)/bi/_v2/queries';
import { catalogue, CAT } from '../bi-v2-fixtures';

const cat = catalogue();

describe('the customer filter (#951)', () => {
  it('is sent only when the user chose it', () => {
    const plain = parseState({});
    expect(filtersOf(plain).customer_types).toBeUndefined();
    expect(productsQuery(cat, plain, 'product_net_ex_tax_minor', 'desc').query).not.toBeNull();
    expect(categoriesQuery(cat, plain).query).not.toBeNull();
    for (const q of overviewQueries(cat, plain).queries)
      expect(q.filters?.customer_types).toBeUndefined();
    expect(filtersOf(parseState({ customer: 'new' })).customer_types).toEqual(['new']);
  });

  it('a product or category view under a customer filter is not sent, and says why in words', () => {
    const state = parseState({ customer: 'returning' });
    expect(productsQuery(cat, state, 'product_net_ex_tax_minor', 'desc').query).toBeNull();
    expect(categoriesQuery(cat, state).query).toBeNull();
    expect(customerFilterRefused(state, ['product'])).toBe(true);
    expect(SMALL_CELL_REFUSAL).toBe(
      'This breakdown can’t be combined with a customer filter — small groups of customers can’t be protected.',
    );
  });

  it('a breakdown by category under a customer filter is refused; by country it is sent with the filter', () => {
    const byCategory = parseState({ customer: 'new', by: 'category', compare: 'previous_period' });
    expect(breakdownQuery(cat, byCategory).query).toBeNull();
    expect(moversQuery(byCategory)).toBeNull();
    const byCountry = parseState({ customer: 'new', by: 'country', compare: 'previous_period' });
    expect(breakdownQuery(cat, byCountry).query?.filters?.customer_types).toEqual(['new']);
    expect(moversQuery(byCountry)?.filters?.customer_types).toEqual(['new']);
  });

  it('a customer filter under a category filter refuses the whole overview (no figure can be protected)', () => {
    const state = parseState({ customer: 'new', category: CAT });
    expect(customerFilterRefused(state, [])).toBe(true);
    expect(overviewQueries(cat, state).queries).toEqual([]);
    expect(customerFilterRefused(parseState({ category: CAT }), [])).toBe(false);
  });
});
