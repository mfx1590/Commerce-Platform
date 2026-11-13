import { describe, expect, it } from 'vitest';
import {
  missingPaymentMethod,
  PRECONDITION_PREFIX,
  preconditionError,
  storePrecondition,
} from '../e2e/support/preconditions';

/**
 * #830: a spec that needs something from the store says so at once, by name, instead of timing out
 * on an element that never renders. These pin the wording a run's log is searched for.
 */

describe('storePrecondition', () => {
  it('passes silently when the store has what the spec needs', () => {
    expect(() => storePrecondition(true, 'two listed products')).not.toThrow();
  });

  it('names what is missing and says it is the store, not the app', () => {
    expect(() => storePrecondition(false, 'two listed products')).toThrow(
      `${PRECONDITION_PREFIX}: two listed products. This is the store's data or settings, not an app failure`,
    );
  });

  it('preconditionError carries the same wording', () => {
    expect(preconditionError('x').message.startsWith(`${PRECONDITION_PREFIX}: x.`)).toBe(true);
  });
});

describe('missingPaymentMethod', () => {
  it('is null when the wanted method is offered', () => {
    expect(missingPaymentMethod('invoice', ['Card', 'Pay on invoice'])).toBeNull();
    expect(missingPaymentMethod('card', ['Card', 'Pay on invoice'])).toBeNull();
  });

  it('names an empty payment.methods (the brand D case)', () => {
    const message = missingPaymentMethod('invoice', []);
    expect(message).toContain('no invoice payment method');
    expect(message).toContain('offered: none');
    expect(message).toContain('payment.methods');
  });

  it('lists what was offered instead', () => {
    expect(missingPaymentMethod('invoice', ['Card'])).toContain('offered: "Card"');
  });

  it('points a missing card at the Stripe test key as well', () => {
    const message = missingPaymentMethod('card', ['Pay on invoice']);
    expect(message).toContain('no card payment method');
    expect(message).toContain('Stripe TEST publishable key');
  });

  it('matches Card only at the start of the label', () => {
    expect(missingPaymentMethod('card', ['Gift card'])).not.toBeNull();
  });
});
