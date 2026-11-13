import { describe, expect, it } from 'vitest';
import {
  classifyPayment,
  offersMethod,
  paymentError,
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

describe('classifyPayment (#840 review: blame the store only when it says so)', () => {
  const lists = (methods: string[] | null, stripeKeyForRun = true) =>
    ({ ok: true, methods, stripeKeyForRun }) as const;

  it('is offered when the step rendered the method; the store is not consulted', () => {
    expect(
      classifyPayment('invoice', ['Card', 'Pay on invoice'], { ok: false, detail: 'x' }),
    ).toEqual({
      kind: 'offered',
    });
    expect(classifyPayment('card', ['Card'], lists([])).kind).toBe('offered');
  });

  it('payment.methods lacks it: a store precondition (the brand D case)', () => {
    const verdict = classifyPayment('invoice', [], lists([]));
    expect(verdict.kind).toBe('precondition');
    const message = paymentError(verdict as Exclude<typeof verdict, { kind: 'offered' }>).message;
    expect(message.startsWith(`${PRECONDITION_PREFIX}: `)).toBe(true);
    expect(message).toContain('payment.methods is []');
    expect(message).toContain('offered: none');
  });

  it('payment.methods absent: a store precondition, named as such', () => {
    const verdict = classifyPayment('invoice', ['Card'], lists(null));
    expect(verdict.kind).toBe('precondition');
    expect(verdict.kind !== 'offered' && verdict.message).toContain('no payment.methods');
  });

  it('payment.methods lists it but the step did not render it: an APP failure', () => {
    const verdict = classifyPayment('invoice', [], lists(['card', 'invoice']));
    expect(verdict.kind).toBe('app');
    const message = paymentError(verdict as Exclude<typeof verdict, { kind: 'offered' }>).message;
    expect(message).not.toContain(PRECONDITION_PREFIX);
    expect(message).toContain('did not render a method the store offers');
  });

  it('GET /store could not be read: an APP failure, never the store’s', () => {
    const verdict = classifyPayment('invoice', [], { ok: false, detail: 'HTTP 500' });
    expect(verdict.kind).toBe('app');
    const message = paymentError(verdict as Exclude<typeof verdict, { kind: 'offered' }>).message;
    expect(message).not.toContain(PRECONDITION_PREFIX);
    expect(message).toContain('GET /store failed');
    expect(message).toContain('HTTP 500');
  });

  it('card listed but no Stripe test key for the run: a precondition naming the key', () => {
    const verdict = classifyPayment('card', ['Pay on invoice'], lists(['card', 'invoice'], false));
    expect(verdict.kind).toBe('precondition');
    expect(verdict.kind !== 'offered' && verdict.message).toContain('Stripe TEST publishable key');
  });

  it('card listed and a key present but not rendered: an app failure', () => {
    expect(classifyPayment('card', ['Pay on invoice'], lists(['card'])).kind).toBe('app');
  });

  it('matches Card only at the start of a label', () => {
    expect(offersMethod('card', ['Gift card'])).toBe(false);
    expect(offersMethod('card', ['Card'])).toBe(true);
  });
});
