'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { clearCart, getCart, getOrCreateCart } from './cart';
import { mapCheckoutError, parseAddressForm, stepPath } from './checkout';
import { checkoutIdempotencyKey, clearIdempotencyKey } from './idempotency';
import { storeApi } from './store-api';

/**
 * Every mutation the storefront performs. They run on the server with the typed client, so the
 * browser never holds the API key and never sets a price, a total or a stock number itself.
 *
 * Shape: do the network call inside try/catch and return an error state; call `redirect()` only
 * after it, because `redirect` signals by throwing and would otherwise be caught as a failure.
 */

export interface ActionState {
  error?: string;
  fieldErrors?: Record<string, string>;
  /** For `out_of_stock`, so the page can offer to reduce the quantity to what is left. */
  availableQuantity?: number;
}

const OK: ActionState = {};

/** The email is needed to look an order up after checkout (`GET /store/orders/{id}?email=`). */
const ORDER_EMAIL_COOKIE = 'order_email';

function intField(formData: FormData, name: string): number | undefined {
  const raw = formData.get(name);
  if (typeof raw !== 'string') return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringField(formData: FormData, name: string): string | undefined {
  const raw = formData.get(name);
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

// ── cart ─────────────────────────────────────────────────────────────────────────────────────────

export async function addToCartAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const variantId = stringField(formData, 'variant_id');
  const quantity = intField(formData, 'quantity') ?? 1;
  if (variantId === undefined) return { error: 'Choose an option before adding to the cart.' };

  try {
    const cart = await getOrCreateCart();
    await storeApi().addLineItem(cart.id, { variant_id: variantId, quantity });
  } catch (error) {
    const mapped = mapCheckoutError(error);
    return {
      error: mapped.message,
      ...(mapped.availableQuantity === undefined
        ? {}
        : { availableQuantity: mapped.availableQuantity }),
    };
  }
  redirect('/cart');
}

export async function updateLineItemAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const lineItemId = stringField(formData, 'line_item_id');
  const quantity = intField(formData, 'quantity');
  if (lineItemId === undefined || quantity === undefined) return { error: 'Invalid quantity.' };

  const cart = await getCart();
  if (!cart) return { error: 'Your cart has expired. Please start again.' };

  try {
    if (quantity <= 0) await storeApi().removeLineItem(cart.id, lineItemId);
    else await storeApi().updateLineItem(cart.id, lineItemId, { quantity });
  } catch (error) {
    const mapped = mapCheckoutError(error);
    return {
      error: mapped.message,
      ...(mapped.availableQuantity === undefined
        ? {}
        : { availableQuantity: mapped.availableQuantity }),
    };
  }
  return OK;
}

export async function removeLineItemAction(formData: FormData): Promise<void> {
  const lineItemId = stringField(formData, 'line_item_id');
  const cart = await getCart();
  if (cart && lineItemId !== undefined) {
    await storeApi().removeLineItem(cart.id, lineItemId);
  }
}

// ── checkout steps ───────────────────────────────────────────────────────────────────────────────

export async function saveAddressAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = parseAddressForm(formData);
  if (parsed.address === undefined || parsed.email === undefined) {
    return { error: 'Please correct the highlighted fields.', fieldErrors: parsed.errors };
  }

  const cart = await getCart();
  if (!cart) return { error: 'Your cart has expired. Please start again.' };

  try {
    await storeApi().updateCart(cart.id, {
      email: parsed.email,
      shipping_address: parsed.address,
      // Phase 1 bills to the delivery address; a separate billing address is Phase 2 work.
      billing_address: parsed.address,
      country: parsed.address.country,
    });
  } catch (error) {
    return { error: mapCheckoutError(error).message };
  }
  redirect(stepPath('shipping'));
}

export async function saveShippingAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const shippingOptionId = stringField(formData, 'shipping_option_id');
  if (shippingOptionId === undefined) return { error: 'Choose a delivery option.' };

  const cart = await getCart();
  if (!cart) return { error: 'Your cart has expired. Please start again.' };

  try {
    await storeApi().updateCart(cart.id, { shipping_option_id: shippingOptionId });
  } catch (error) {
    return { error: mapCheckoutError(error).message };
  }
  redirect(stepPath('payment'));
}

/**
 * Phase 1 uses the `manual` provider: no card data, no hosted fields, nothing to leak. Window 7
 * replaces this with Stripe hosted fields driven by `payment_session.client_secret` in Phase 2 —
 * card details never reach our servers either way.
 */
export async function createPaymentSessionAction(
  _previous: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const cart = await getCart();
  if (!cart) return { error: 'Your cart has expired. Please start again.' };

  try {
    await storeApi().createPaymentSession(cart.id, { provider: 'manual' });
  } catch (error) {
    return { error: mapCheckoutError(error).message };
  }
  redirect(stepPath('review'));
}

export async function placeOrderAction(
  _previous: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  const cart = await getCart();
  if (!cart) return { error: 'Your cart has expired. Please start again.' };

  let orderId: string;
  try {
    // The session is created here rather than gating the review step on it: it is a PSP artifact
    // with its own lifetime, and one that expired between steps must not strand the customer.
    if (cart.payment_session === null || cart.payment_session.status === 'failed') {
      await storeApi().createPaymentSession(cart.id, { provider: 'manual' });
    }
    // Generated once for this cart and reused on every retry, so a timeout cannot double-charge.
    const idempotencyKey = await checkoutIdempotencyKey(cart.id);
    const order = await storeApi().completeCart(cart.id, idempotencyKey);
    orderId = order.id;

    if (cart.email !== null) {
      (await cookies()).set(ORDER_EMAIL_COOKIE, cart.email, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 60 * 60,
      });
    }
    await clearCart();
    await clearIdempotencyKey();
  } catch (error) {
    const mapped = mapCheckoutError(error);
    // The cart was already completed: send the customer to the order rather than to an error.
    if (mapped.orderId !== undefined) {
      await clearCart();
      await clearIdempotencyKey();
      redirect(`/orders/${mapped.orderId}`);
    }
    if (mapped.step !== undefined) redirect(`${stepPath(mapped.step)}?error=${mapped.code}`);
    return {
      error: mapped.message,
      ...(mapped.availableQuantity === undefined
        ? {}
        : { availableQuantity: mapped.availableQuantity }),
    };
  }
  redirect(`/orders/${orderId}`);
}
