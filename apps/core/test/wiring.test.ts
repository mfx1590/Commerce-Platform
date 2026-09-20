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

  it('is idempotent: a second call registers nothing again', () => {
    setPriceResolver(defaultListPriceResolver); // what a test (or an operator script) put back …
    const tax = currentTaxCalculator();
    registerModuleSeams();
    expect(currentPriceResolver()).toBe(defaultListPriceResolver); // … stays put
    expect(currentTaxCalculator()).toBe(tax);
  });
});
