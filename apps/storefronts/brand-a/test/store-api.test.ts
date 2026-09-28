import { HEADERS } from '@platform/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  allowsCustomerToken,
  buildUrl,
  StoreApiClient,
  StoreApiError,
  isNotFound,
  storeApiConfigFromEnv,
} from '@/lib/store-api';

const CONFIG = { baseUrl: 'http://localhost:4010', publishableKey: 'pk_test' };

/** A `fetch` stand-in that records the call and answers with `body`. */
function stubFetch(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, requestInit?: RequestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('buildUrl', () => {
  it('joins base and path and drops empty query values', () => {
    expect(
      buildUrl('http://localhost:4010/', '/store/products', {
        page: 2,
        category: 't-shirts',
        q: '',
        tag: undefined,
        sort: null,
      }),
    ).toBe('http://localhost:4010/store/products?page=2&category=t-shirts');
  });

  it('encodes query values', () => {
    expect(buildUrl('http://x', '/store/products', { q: 'blue shirt & tie' })).toBe(
      'http://x/store/products?q=blue+shirt+%26+tie',
    );
  });
});

describe('StoreApiClient', () => {
  it('sends the publishable key on every request', async () => {
    const { impl, calls } = stubFetch({ id: '1', name: 'Brand A' });
    await new StoreApiClient({ ...CONFIG, fetchImpl: impl }).getStore();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://localhost:4010/store');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get(HEADERS.publishableKey)).toBe('pk_test');
  });

  it('passes query parameters and cache tags through', async () => {
    const { impl, calls } = stubFetch({ page: 1, limit: 24, total: 0, items: [] });
    await new StoreApiClient({ ...CONFIG, fetchImpl: impl }).listProducts(
      { category: 't-shirts', page: 2, sort: 'price_asc' },
      { tags: ['products'], revalidate: 60 },
    );

    expect(calls[0]?.url).toBe(
      'http://localhost:4010/store/products?category=t-shirts&page=2&sort=price_asc',
    );
    expect((calls[0]?.init as { next?: unknown }).next).toEqual({
      tags: ['products'],
      revalidate: 60,
    });
  });

  it('sends a JSON body and content-type on writes', async () => {
    const { impl, calls } = stubFetch({ id: 'cart-1' }, { status: 201 });
    await new StoreApiClient({ ...CONFIG, fetchImpl: impl }).createCart({ currency: 'EUR' });

    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe(JSON.stringify({ currency: 'EUR' }));
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe('application/json');
  });

  it('sends the idempotency key when completing a cart', async () => {
    const { impl, calls } = stubFetch({ id: 'order-1' });
    await new StoreApiClient({ ...CONFIG, fetchImpl: impl }).completeCart('cart-1', 'key-123');

    expect(calls[0]?.url).toBe('http://localhost:4010/store/carts/cart-1/complete');
    expect(new Headers(calls[0]?.init.headers).get(HEADERS.idempotencyKey)).toBe('key-123');
  });

  it('maps an error response to StoreApiError with the contract error code', async () => {
    const { impl } = stubFetch(
      { code: 'out_of_stock', message: 'Only 2 left', details: { available_quantity: 2 } },
      { status: 409, headers: { [HEADERS.requestId]: 'req-1' } },
    );
    const client = new StoreApiClient({ ...CONFIG, fetchImpl: impl });

    const error = await client.getCart('cart-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreApiError);
    const apiError = error as StoreApiError;
    expect(apiError.status).toBe(409);
    expect(apiError.is('out_of_stock')).toBe(true);
    expect(apiError.details).toEqual({ available_quantity: 2 });
    expect(apiError.requestId).toBe('req-1');
    expect(apiError.message).toBe('Only 2 left');
    expect(isNotFound(apiError)).toBe(false);
  });

  it('recognises a 404 so a page can call notFound()', async () => {
    const { impl } = stubFetch({ code: 'not_found', message: 'Not found' }, { status: 404 });
    const client = new StoreApiClient({ ...CONFIG, fetchImpl: impl });

    const error = await client.getProduct('nope').catch((e: unknown) => e);
    expect(isNotFound(error)).toBe(true);
  });
});

describe('customer token handling', () => {
  it('allows the token only on customer-scoped paths', () => {
    expect(allowsCustomerToken('/store/customers')).toBe(true);
    expect(allowsCustomerToken('/store/customers/me')).toBe(true);
    expect(allowsCustomerToken('/store/customers/me/orders')).toBe(true);
    expect(allowsCustomerToken('/store/orders/order-1')).toBe(true);

    expect(allowsCustomerToken('/store')).toBe(false);
    expect(allowsCustomerToken('/store/products')).toBe(false);
    expect(allowsCustomerToken('/store/carts/cart-1')).toBe(false);
    expect(allowsCustomerToken('/store/carts/cart-1/complete')).toBe(false);
  });

  it('attaches the bearer token on an allowed path', async () => {
    const { impl, calls } = stubFetch({ id: 'cus-1' });
    await new StoreApiClient({ ...CONFIG, fetchImpl: impl }).getMe({ token: 'jwt-abc' });

    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer jwt-abc');
  });

  it('refuses to leak the token onto a store-scoped path', async () => {
    const { impl, calls } = stubFetch({ id: 'p1' });
    const client = new StoreApiClient({ ...CONFIG, fetchImpl: impl });

    // `getProduct` takes the 0.3.0 `currency` query second and the request options third (2.1).
    await expect(client.getProduct('classic-tee', undefined, { token: 'jwt-abc' })).rejects.toThrow(
      /Refusing to send a customer token/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('storeApiConfigFromEnv', () => {
  // Since 2.1 the unconfigured default is the core, not the mock; see test/real-api.test.ts for
  // the full precedence and why.
  it('prefers STORE_API_URL, then MOCK_API_URL, then the core', () => {
    expect(
      storeApiConfigFromEnv({ STORE_API_URL: 'https://api.example.com', MOCK_API_URL: 'x' })
        .baseUrl,
    ).toBe('https://api.example.com');
    expect(storeApiConfigFromEnv({ MOCK_API_URL: 'http://localhost:4010' }).baseUrl).toBe(
      'http://localhost:4010',
    );
    expect(storeApiConfigFromEnv({}).baseUrl).toBe('http://localhost:9000');
  });

  it('takes the publishable key from the environment', () => {
    expect(storeApiConfigFromEnv({ STORE_PUBLISHABLE_KEY: 'pk_live_a' }).publishableKey).toBe(
      'pk_live_a',
    );
  });
});
