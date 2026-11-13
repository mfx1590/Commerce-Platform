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
 * A precondition is claimed only when the store itself says so: a message that blames the store for
 * an app failure is worse than a timeout (#840 review).
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

/** What the test itself read from `GET /store` (only on the failure path). */
export type StoreRead =
  | { ok: true; methods: readonly string[] | null; stripeKeyForRun: boolean }
  | { ok: false; detail: string };

export type PaymentVerdict =
  | { kind: 'offered' }
  | { kind: 'precondition'; message: string }
  | { kind: 'app'; message: string };

/** Did the payment step render `method`? `offered` is the labels of the radios on screen. */
export function offersMethod(method: PaymentChoice, offered: readonly string[]): boolean {
  return offered.some((label) => PAYMENT_LABEL[method].test(label));
}

const methodName = (method: PaymentChoice): string => (method === 'card' ? 'card' : 'invoice');
const listed = (labels: readonly string[]): string =>
  labels.length === 0 ? 'none' : labels.map((label) => `"${label}"`).join(', ');

/**
 * Why the payment step did not offer `method` (#830, review of #840).
 *
 * The step's options come from `getStoreOrNull()`, which turns ANY `GET /store` failure into
 * "no store", and so into "no invoice". The rendered radios alone therefore cannot tell a store
 * that does not allow the method from a broken Store API or a payment-form regression. Only the
 * store's own answer can: a precondition is reported **only** when `payment.methods` really lacks
 * the method (or, for card, the run has no Stripe test key). Everything else is an app failure.
 */
export function classifyPayment(
  method: PaymentChoice,
  offered: readonly string[],
  read: StoreRead,
): PaymentVerdict {
  if (offersMethod(method, offered)) return { kind: 'offered' };
  const name = methodName(method);
  const shown = `the payment step rendered no ${name} option (offered: ${listed(offered)})`;

  if (!read.ok) {
    return {
      kind: 'app',
      message:
        `${shown}, and GET /store failed when the test read it (${read.detail}). Not a store ` +
        'precondition: the Store API, or the app reading it, is failing.',
    };
  }
  if (read.methods === null) {
    return {
      kind: 'precondition',
      message:
        `${shown}: GET /store has no payment.methods at all, so the storefront offers no invoice ` +
        'and card only on a key. The store (or its core version) must list the method',
    };
  }
  if (!read.methods.includes(method)) {
    return {
      kind: 'precondition',
      message:
        `${shown}: GET /store → payment.methods is [${read.methods.join(', ')}], without ` +
        `"${method}". Enable it for the store`,
    };
  }
  if (method === 'card' && !read.stripeKeyForRun) {
    return {
      kind: 'precondition',
      message:
        `${shown}: the store lists card, but this run has no Stripe TEST publishable key ` +
        '(STRIPE_PUBLISHABLE_KEY_<STORE CODE> or STRIPE_PUBLISHABLE_KEY)',
    };
  }
  return {
    kind: 'app',
    message:
      `GET /store → payment.methods lists "${method}" ([${read.methods.join(', ')}]), but ${shown}. ` +
      'An app failure: the payment step did not render a method the store offers.',
  };
}

/** The error to throw for a verdict that is not `offered`. */
export function paymentError(verdict: Exclude<PaymentVerdict, { kind: 'offered' }>): Error {
  return verdict.kind === 'precondition'
    ? preconditionError(verdict.message)
    : new Error(verdict.message);
}
