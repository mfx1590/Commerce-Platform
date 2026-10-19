// src/wiring.ts: what createServer() registers behind the seams, once. No database: every call is a registry write.
import { afterAll, describe, expect, it } from 'vitest';
import {
  currentDiscountEvaluator,
  currentPriceResolver,
  currentShippingRateProvider,
  currentTaxCalculator,
  defaultListPriceResolver,
  noDiscounts,
  setDiscountEvaluator,
  setPriceResolver,
  setShippingRateProvider,
  setTaxCalculator,
  tableShippingRates,
  tableTaxCalculator,
} from '../src/modules/cart';
import {
  currentFraudCheck,
  manualPaymentProvider,
  registeredPaymentProviders,
  setFraudCheck,
} from '../src/modules/checkout';
import {
  currentFraudCheck as fraudModuleCheck,
  setFraudCheck as setFraudModuleCheck,
} from '../src/modules/fraud';
import { stockAwareAllocationPolicy } from '../src/modules/hq-warehouse';
import {
  currentAllocationPolicy,
  priorityGreedyPolicy,
  setAllocationPolicy,
  type AllocationCandidate,
  type AllocationContext,
  type AllocationLine,
} from '../src/modules/inventory';
import {
  currentRefundRequester,
  manualRefundRequester,
  setRefundRequester,
} from '../src/modules/returns';
import { priceListResolver, promotionsDiscountEvaluator, registerModuleSeams } from '../src/wiring';

afterAll(() => {
  setPriceResolver(defaultListPriceResolver);
  setDiscountEvaluator(noDiscounts);
  setTaxCalculator(tableTaxCalculator);
  setShippingRateProvider(tableShippingRates);
  setRefundRequester(manualRefundRequester);
  setFraudCheck(null);
  setFraudModuleCheck(null);
  setAllocationPolicy(priorityGreedyPolicy);
});

// Two warehouses with the same stock item: the one with the better priority number is abroad.
const warehouse = (code: string, country: string, priority: number, available: number) =>
  ({
    warehouseId: `00000000-0000-4000-8000-0000000000${priority}${priority}`,
    warehouseCode: code,
    country,
    priority,
    available,
  }) satisfies AllocationCandidate;
const US = warehouse('wh-us', 'US', 1, 5);
const DE = warehouse('wh-de', 'DE', 2, 5);
const toGermany: AllocationContext = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  storeId: '00000000-0000-4000-8000-000000000002',
  orderId: '00000000-0000-4000-8000-000000000003',
  destinationCountry: 'DE',
  routingSettings: null,
};
const line = (quantity: number, candidates: AllocationCandidate[]): AllocationLine => ({
  variantId: '00000000-0000-4000-8000-000000000004',
  stockItemId: '00000000-0000-4000-8000-000000000005',
  quantity,
  allowBackorder: false,
  candidates,
});

describe('registerModuleSeams()', () => {
  it('starts from the built-in defaults', () => {
    expect(currentPriceResolver()).toBe(defaultListPriceResolver);
    expect(currentDiscountEvaluator()).toBe(noDiscounts);
    expect(currentTaxCalculator()).toBe(tableTaxCalculator);
    expect(currentShippingRateProvider()).toBe(tableShippingRates);
    expect(currentRefundRequester()).toBe(manualRefundRequester);
    expect(registeredPaymentProviders()).toEqual([manualPaymentProvider.name]);
    expect(currentFraudCheck()).toBeNull();
    expect(currentAllocationPolicy()).toBe(priorityGreedyPolicy);
    // the built-in policy knows nothing of the destination: the priority warehouse serves the line
    expect(currentAllocationPolicy()(toGermany, [line(2, [US, DE])])[0]?.allocations).toEqual([
      { warehouseId: US.warehouseId, quantity: 2, rule: 'priority' },
    ]);
  });

  it('registers payments (+ the refund requester), carrier rates, tax and price lists — without any configuration', () => {
    expect(() => registerModuleSeams()).not.toThrow();
    expect(registeredPaymentProviders()).toEqual(expect.arrayContaining(['manual', 'stripe']));
    expect(currentRefundRequester()).not.toBe(manualRefundRequester);
    expect(currentShippingRateProvider()).not.toBe(tableShippingRates);
    expect(currentTaxCalculator()).not.toBe(tableTaxCalculator);
    expect(currentPriceResolver()).toBe(priceListResolver);
    expect(currentDiscountEvaluator()).toBe(promotionsDiscountEvaluator);
    // the fraud check reaches the seam completeCart actually reads — the same object the fraud module registered
    expect(currentFraudCheck()).not.toBeNull();
    expect(currentFraudCheck()).toBe(fraudModuleCheck());
  });

  it("registers window 11's stock-aware engine behind the allocation seam (#435)", () => {
    expect(currentAllocationPolicy()).toBe(stockAwareAllocationPolicy);
    const decide = currentAllocationPolicy();
    // what a placement now gets: the warehouse in the destination country, whatever its priority number …
    expect(decide(toGermany, [line(2, [US, DE])])[0]?.allocations).toEqual([
      { warehouseId: DE.warehouseId, quantity: 2, rule: 'same_country' },
    ]);
    // … one warehouse that covers the whole line before a nearer split …
    expect(decide(toGermany, [line(4, [US, { ...DE, available: 3 }])])[0]?.allocations).toEqual([
      { warehouseId: US.warehouseId, quantity: 4, rule: 'priority' },
    ]);
    // … and a split, nearest first, only when no single warehouse can
    expect(decide(toGermany, [line(7, [US, { ...DE, available: 3 }])])[0]).toEqual({
      variantId: line(7, []).variantId,
      allocations: [
        { warehouseId: DE.warehouseId, quantity: 3, rule: 'same_country' },
        { warehouseId: US.warehouseId, quantity: 4, rule: 'split:priority' },
      ],
      shortfall: 0,
    });
  });

  it('is idempotent: a second call registers nothing again', () => {
    setPriceResolver(defaultListPriceResolver); // what a test (or an operator script) put back …
    const tax = currentTaxCalculator();
    registerModuleSeams();
    expect(currentPriceResolver()).toBe(defaultListPriceResolver); // … stays put
    expect(currentTaxCalculator()).toBe(tax);
  });
});
