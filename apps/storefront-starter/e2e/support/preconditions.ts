/**
 * Store preconditions (#830): what a spec needs the STORE to have before it can observe anything.
 *
 * A spec that needs one asserts it **before it interacts**, and fails at once with a sentence that
 * names what is missing and says it is the store's data or settings, not the app. Without that, a
 * missing precondition looks like a frontend bug. The brand D proving run hit six, one at a time:
 * - purchasable stock;
 * - a payment method;
 * - two listed products;
 * - a product in a category;
 * - a product outside it;
 * - a product image.
 * The payment one cost 180 silent seconds per test, waiting on a radio that never renders.
 *
 * Plain TypeScript, no Playwright: `test/e2e-preconditions.test.ts` pins the messages.
 */

export const PRECONDITION_PREFIX = 'Store precondition not met';

/** The error a missing precondition throws. One wording, so a run's log is searchable. */
export function preconditionError(what: string): Error {
  return new Error(
    `${PRECONDITION_PREFIX}: ${what}. This is the store's data or settings, not an app failure — seed or configure the store and run again.`,
  );
}

/** Throws `preconditionError(what)` unless `ok`. */
export function storePrecondition(ok: boolean, what: string): asserts ok {
  if (!ok) throw preconditionError(what);
}

export type PaymentChoice = 'invoice' | 'card';

/** The radio label the payment step shows for each method (`messages/*.json` → checkout). */
export const PAYMENT_LABEL: Record<PaymentChoice, RegExp> = {
  card: /^Card/,
  invoice: /Pay on invoice/,
};

/**
 * Null when the payment step offers `method`; otherwise what to tell the person running the suite.
 * `offered` is the labels of the radios the step actually rendered.
 */
export function missingPaymentMethod(method: PaymentChoice, offered: string[]): string | null {
  if (offered.some((label) => PAYMENT_LABEL[method].test(label))) return null;
  const list = offered.length === 0 ? 'none' : offered.map((label) => `"${label}"`).join(', ');
  return (
    `the payment step offers no ${method === 'card' ? 'card' : 'invoice'} payment method ` +
    `(offered: ${list}). Enable it for the store: GET /store → payment.methods` +
    (method === 'card' ? ', plus a Stripe TEST publishable key' : '')
  );
}
