import { describe, expect, it, vi } from 'vitest';
import { mapCheckoutError } from '@/lib/checkout';
import {
  DEFAULT_STORE_API_URL,
  StoreApiClient,
  StoreApiError,
  storeApiConfigFromEnv,
} from '@/lib/store-api';

/**
 * Task 2.1: the starter talks to the real core, not to Prism.
 *
 * Prism answered from the contract's examples — every handle existed, stock was always available
 * and the only error bodies ever seen were the ones the spec illustrates. These tests pin the
 * behaviour that only matters once a real implementation is on the other end: which base URL is
 * chosen, that the 0.3.0 `currency` query actually reaches the API, and that every error code the
 * core can return maps to something the checkout can act on.
 */

function stubFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('base URL selection', () => {
  it('defaults to the core: it answers the whole journey since core 2.2', () => {
    expect(storeApiConfigFromEnv({}).baseUrl).toBe(DEFAULT_STORE_API_URL);
  });

  it('lets MOCK_API_URL select Prism — which is how Playwright and an offline build still run', () => {
    expect(storeApiConfigFromEnv({ MOCK_API_URL: 'http://localhost:4010' }).baseUrl).toBe(
      'http://localhost:4010',
    );
  });

  it('gives STORE_API_URL the last word, for a deployment that names its own core', () => {
    expect(
      storeApiConfigFromEnv({
        STORE_API_URL: 'https://api.brand-a.example',
        MOCK_API_URL: 'http://localhost:4010',
      }).baseUrl,
    ).toBe('https://api.brand-a.example');
  });
});

describe('the currency query (Store API 0.3.0)', () => {
  it('is sent on the product list', async () => {
    const { impl, calls } = stubFetch({ items: [], total: 0, page: 1, limit: 24 });
    const client = new StoreApiClient({
      baseUrl: 'http://localhost:9000',
      publishableKey: 'pk_test',
      fetchImpl: impl,
    });

    await client.listProducts({ page: 1, limit: 24, currency: 'GBP' });
    expect(calls[0]).toContain('currency=GBP');
  });

  it('is sent on the product detail', async () => {
    const { impl, calls } = stubFetch({ handle: 'a-product' });
    const client = new StoreApiClient({
      baseUrl: 'http://localhost:9000',
      publishableKey: 'pk_test',
      fetchImpl: impl,
    });

    await client.getProduct('a-product', { currency: 'GBP' });
    expect(calls[0]).toBe('http://localhost:9000/store/products/a-product?currency=GBP');
  });

  it('is omitted when no currency is chosen, so the core prices in the store default', async () => {
    const { impl, calls } = stubFetch({ handle: 'a-product' });
    const client = new StoreApiClient({
      baseUrl: 'http://localhost:9000',
      publishableKey: 'pk_test',
      fetchImpl: impl,
    });

    await client.getProduct('a-product');
    expect(calls[0]).toBe('http://localhost:9000/store/products/a-product');
  });
});

describe('mapping the error bodies the core actually returns', () => {
  const error = (status: number, code: string, details: Record<string, unknown> = {}) =>
    new StoreApiError(status, { code, message: 'from the core', details });

  it('401 unauthorized — a missing, unknown or revoked publishable key', () => {
    // The core answers `unauthorized` here (storeContextMiddleware). Issue #109 predicted
    // `invalid_publishable_key`, which is not one of the contract's ERROR_CODES; both map.
    for (const code of ['unauthorized', 'invalid_publishable_key', 'forbidden']) {
      const mapped = mapCheckoutError(error(401, code));
      expect(mapped.code).toBe(code);
      expect(mapped.message).toMatch(/not available right now/i);
      // Nothing the customer typed can fix a misconfigured key: do not send them to a form.
      expect(mapped.step).toBeUndefined();
    }
  });

  it('400 validation_error sends the customer back to the step that holds the input', () => {
    const mapped = mapCheckoutError(error(400, 'validation_error'));
    expect(mapped.step).toBe('address');
  });

  it('404 not_found means the cart is gone, not that the page is missing', () => {
    expect(mapCheckoutError(error(404, 'not_found')).message).toMatch(/expired/i);
  });

  it('409 cart_completed carries the order that already exists', () => {
    const mapped = mapCheckoutError(error(409, 'cart_completed', { order_id: 'order-alpha' }));
    expect(mapped.orderId).toBe('order-alpha');
  });

  it('409 conflict is recoverable by re-reading the cart', () => {
    expect(mapCheckoutError(error(409, 'conflict')).message).toMatch(/cart changed/i);
  });

  it('409 out_of_stock reports what the core says is actually left', () => {
    const mapped = mapCheckoutError(error(409, 'out_of_stock', { available: 2 }));
    expect(mapped.availableQuantity).toBe(2);
    expect(mapped.message).toContain('2');
  });

  it('a sold-out variant is worded as sold out, not as "reduce the quantity to 0"', () => {
    expect(mapCheckoutError(error(409, 'out_of_stock', { available: 0 })).message).toMatch(
      /sold out/i,
    );
  });

  it('402 payment_failed returns to the payment step', () => {
    expect(mapCheckoutError(error(402, 'payment_failed')).step).toBe('payment');
  });

  it('500 internal — and any code we have never seen — is generic, never a raw core message', () => {
    for (const code of ['internal', 'some_code_from_a_future_core']) {
      const mapped = mapCheckoutError(error(500, code));
      expect(mapped.message).toBe('Something went wrong. Please try again.');
      expect(mapped.message).not.toContain('from the core');
    }
  });

  it('a non-API failure (DNS, timeout) is still mapped rather than thrown at the customer', () => {
    expect(mapCheckoutError(new TypeError('fetch failed')).code).toBe('internal');
  });
});
