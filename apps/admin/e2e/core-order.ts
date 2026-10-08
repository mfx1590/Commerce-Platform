import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { APIRequestContext } from '@playwright/test';

/**
 * Core mode only (#285): the orders journeys must not depend on rows a long-lived database happens
 * to hold. Before them, a guest order is placed through the **Store API** of the same core, the way
 * a storefront does — cart → line → address + shipping → `manual` payment session → complete.
 *
 * The publishable key is the seeded brand-a **dev** key: `STORE_PUBLISHABLE_KEY` when the run sets
 * it, otherwise the value `.env.example` documents (the CI job removes `.env`). It only works
 * against a core seeded by packages/db, which is exactly what the core-mode run is.
 *
 * The `manual` provider only *authorizes* (apps/core/src/lib/payment-seam.ts); capture is Stripe
 * only, so an order placed here is never refundable — the refund journey says so and skips.
 */

const ADDRESS = {
  first_name: 'Jane',
  last_name: 'Doe',
  line1: 'Keizersgracht 1',
  city: 'Amsterdam',
  postal_code: '1015 CJ',
  country: 'NL',
};

export interface PlacedOrder {
  id: string;
  display_id: number;
  payment_status: string;
}

/** The seeded brand-a dev publishable key (env, else the value `.env.example` documents). */
export function publishableKey(): string {
  const fromEnv = process.env.STORE_PUBLISHABLE_KEY;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  // Playwright runs from apps/admin.
  const example = readFileSync(resolve(process.cwd(), '../../.env.example'), 'utf8');
  const line = /^STORE_PUBLISHABLE_KEY=(.+)$/m.exec(example);
  if (line?.[1] === undefined) throw new Error('.env.example documents no STORE_PUBLISHABLE_KEY');
  return line[1].trim();
}

export async function placeCoreOrder(
  request: APIRequestContext,
  coreUrl: string,
  stamp: string,
): Promise<PlacedOrder> {
  const headers = { 'X-Publishable-Key': publishableKey() };
  const call = async <T>(method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown) => {
    const response = await request.fetch(`${coreUrl}${path}`, {
      method,
      headers: {
        ...headers,
        ...(path.endsWith('/complete') ? { 'Idempotency-Key': `admin-e2e-${stamp}` } : {}),
      },
      ...(data === undefined ? {} : { data }),
    });
    if (!response.ok()) {
      throw new Error(`Store API ${method} ${path} → ${response.status()}`);
    }
    return (await response.json()) as T;
  };

  const cart = await call<{ id: string }>('POST', '/store/carts', {});
  // A fresh seed's stock is random per variant: take the first in-stock variant of any product.
  const products = await call<{ items: { handle: string }[] }>(
    'GET',
    '/store/products?limit=20&sort=price_asc',
  );
  let variantId: string | null = null;
  for (const { handle } of products.items) {
    const product = await call<{ variants: { id: string; in_stock: boolean }[] }>(
      'GET',
      `/store/products/${handle}`,
    );
    variantId = product.variants.find((variant) => variant.in_stock)?.id ?? null;
    if (variantId !== null) break;
  }
  if (variantId === null) throw new Error('no in-stock variant among the first 20 products');

  await call('POST', `/store/carts/${cart.id}/line-items`, { variant_id: variantId, quantity: 1 });
  const options = await call<{ items: { id: string }[] }>(
    'GET',
    `/store/carts/${cart.id}/shipping-options`,
  );
  const shipping = options.items[0];
  if (shipping === undefined) throw new Error('no shipping option for NL');
  await call('PATCH', `/store/carts/${cart.id}`, {
    email: `admin-e2e+${stamp}@example.com`,
    shipping_address: ADDRESS,
    billing_address: ADDRESS,
    shipping_option_id: shipping.id,
  });
  await call('POST', `/store/carts/${cart.id}/payment-session`, { provider: 'manual' });
  return call<PlacedOrder>('POST', `/store/carts/${cart.id}/complete`);
}
