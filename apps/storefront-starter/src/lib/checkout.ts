import type { Address, Cart } from './store-api';
import { isStoreApiError } from './store-api';

/**
 * Checkout rules that do not touch the network: which step comes next, how a form becomes an
 * Address, and what an API failure means for the customer. Pure, so every branch is unit-tested
 * rather than discovered in production.
 */

export const CHECKOUT_STEPS = ['address', 'shipping', 'payment', 'review'] as const;
export type CheckoutStep = (typeof CHECKOUT_STEPS)[number];

export const STEP_LABELS: Record<CheckoutStep, string> = {
  address: 'Address',
  shipping: 'Delivery',
  payment: 'Payment',
  review: 'Review',
};

export function stepPath(step: CheckoutStep): string {
  return `/checkout/${step}`;
}

/** What the cart still needs. Drives both the redirect and the progress indicator. */
export function nextIncompleteStep(cart: Cart): CheckoutStep {
  if (cart.email === null || cart.shipping_address === null) return 'address';
  if (cart.shipping_option === null) return 'shipping';
  if (cart.payment_session === null || cart.payment_session.status === 'failed') return 'payment';
  return 'review';
}

/**
 * A customer may go back to an earlier step, and may look ahead as far as their *own input* allows —
 * but never past it: review with no address could place an incomplete order.
 *
 * Reachability deliberately does not depend on `payment_session`. That session is a PSP artifact,
 * not customer input: the customer chooses a *method* at the payment step, and `placeOrderAction`
 * creates the session immediately before authorising. Gating review on it would strand anyone whose
 * session expired between steps. (Window 7 revisits this for Stripe hosted fields, which need the
 * `client_secret` while the customer is still on the payment step.)
 */
export function isStepReachable(cart: Cart, step: CheckoutStep): boolean {
  const hasAddress = cart.email !== null && cart.shipping_address !== null;
  switch (step) {
    case 'address':
      return true;
    case 'shipping':
      return hasAddress;
    case 'payment':
    case 'review':
      return hasAddress && cart.shipping_option !== null;
  }
}

export function isCheckoutable(cart: Cart | null): cart is Cart {
  return cart !== null && cart.status === 'active' && cart.items.length > 0;
}

// ── address form ─────────────────────────────────────────────────────────────────────────────────

export interface AddressFormResult {
  address?: Address;
  email?: string;
  errors: Record<string, string>;
}

const REQUIRED_ADDRESS_FIELDS = [
  ['first_name', 'First name'],
  ['last_name', 'Last name'],
  ['line1', 'Address'],
  ['city', 'City'],
  ['postal_code', 'Postal code'],
  ['country', 'Country'],
] as const;

function value(formData: FormData, name: string): string {
  const raw = formData.get(name);
  return typeof raw === 'string' ? raw.trim() : '';
}

function optional(formData: FormData, name: string): string | null {
  const trimmed = value(formData, name);
  return trimmed === '' ? null : trimmed;
}

/**
 * Validate the address form before it reaches the API. The contract requires an ISO-3166 alpha-2
 * country and a plausible email; catching that here gives a field-level message instead of a 400.
 */
export function parseAddressForm(formData: FormData): AddressFormResult {
  const errors: Record<string, string> = {};

  const email = value(formData, 'email');
  if (email === '') errors.email = 'Enter your email address';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email address';

  for (const [field, label] of REQUIRED_ADDRESS_FIELDS) {
    if (value(formData, field) === '') errors[field] = `${label} is required`;
  }

  const country = value(formData, 'country').toUpperCase();
  if (country !== '' && !/^[A-Z]{2}$/.test(country)) {
    errors.country = 'Use the two-letter country code, e.g. NL';
  }

  if (Object.keys(errors).length > 0) return { errors };

  return {
    email,
    address: {
      first_name: value(formData, 'first_name'),
      last_name: value(formData, 'last_name'),
      company: optional(formData, 'company'),
      line1: value(formData, 'line1'),
      line2: optional(formData, 'line2'),
      city: value(formData, 'city'),
      region: optional(formData, 'region'),
      postal_code: value(formData, 'postal_code'),
      country,
      phone: optional(formData, 'phone'),
    },
    errors: {},
  };
}

// ── error mapping ────────────────────────────────────────────────────────────────────────────────

export interface CheckoutError {
  message: string;
  /** The contract's machine-readable code, so a page can react without matching on text. */
  code: string;
  /** Where the customer has to go to fix it. */
  step?: CheckoutStep;
  /** Set for `out_of_stock`, so the page can say how many are actually left. */
  availableQuantity?: number;
  /** Set for `out_of_stock`: which variant ran out, when the API says so. */
  variantId?: string;
  /** Set for `cart_completed`: the order already exists and the customer should see it. */
  orderId?: string;
}

function detailNumber(details: Record<string, unknown>, key: string): number | undefined {
  const raw = details[key];
  return typeof raw === 'number' ? raw : undefined;
}

function detailString(details: Record<string, unknown>, key: string): string | undefined {
  const raw = details[key];
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * Turn a Store API failure into something the checkout can act on. The contract's `code` is the
 * contract; the message is only ever a fallback for display.
 */
export function mapCheckoutError(error: unknown): CheckoutError {
  if (!isStoreApiError(error)) {
    return { code: 'internal', message: 'Something went wrong. Please try again.' };
  }

  const code = String(error.code);
  switch (error.code) {
    case 'out_of_stock': {
      // The contract's payload is `details.available` (store-api.yaml, addLineItem 409).
      // `available_quantity` is accepted as a fallback: it is the field name on Variant, and an
      // implementation could plausibly reach for it.
      const available =
        detailNumber(error.details, 'available') ??
        detailNumber(error.details, 'available_quantity');
      const variantId = detailString(error.details, 'variant_id');
      return {
        code,
        message:
          available === undefined
            ? 'That item is no longer in stock.'
            : available === 0
              ? 'That item just sold out.'
              : `Only ${available} left in stock — reduce the quantity to continue.`,
        ...(available === undefined ? {} : { availableQuantity: available }),
        ...(variantId === undefined ? {} : { variantId }),
      };
    }
    case 'payment_failed':
      return {
        code,
        message: error.message || 'Payment was not authorised. Try another payment method.',
        step: 'payment',
      };
    case 'cart_completed': {
      const orderId = detailString(error.details, 'order_id');
      return {
        code,
        message: 'This order has already been placed.',
        ...(orderId === undefined ? {} : { orderId }),
      };
    }
    case 'validation_error':
      return {
        code,
        message: error.message || 'Please check the details you entered.',
        step: 'address',
      };
    case 'not_found':
      return { code, message: 'Your cart has expired. Please start again.' };
    default:
      return { code, message: 'Something went wrong. Please try again.' };
  }
}
