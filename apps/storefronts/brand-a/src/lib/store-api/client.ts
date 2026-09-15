import { HEADERS } from '@platform/contracts';
import { StoreApiError } from './errors';
import type { Body, Query, Result } from './types';

/**
 * The typed Store API client.
 *
 * This module is the ONLY place in the app that knows the base URL, the publishable key and the
 * header names. Pages and components receive typed data and never call `fetch` themselves — that
 * is what keeps a brand app from leaking a key into the browser bundle.
 */

export interface StoreApiConfig {
  baseUrl: string;
  publishableKey: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Next's fetch extensions. Declared here so the client stays a plain `fetch` wrapper. */
interface NextFetchOptions {
  tags?: string[];
  revalidate?: number | false;
}

export interface RequestOptions {
  /** Keycloak customers-realm token. Only sent on customer-scoped paths (see `allowsCustomerToken`). */
  token?: string | undefined;
  /** Generated once per checkout attempt and reused on retry (task 1.4). */
  idempotencyKey?: string | undefined;
  /** Cache tags for `revalidateTag` (task 1.3). */
  tags?: string[] | undefined;
  revalidate?: number | false | undefined;
  cache?: RequestCache | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Paths that may carry the customer's bearer token. Everything else is store-scoped and is
 * authorised by the publishable key alone, so a token must never travel with it.
 */
export function allowsCustomerToken(path: string): boolean {
  return path === '/store/customers' || path.startsWith('/store/customers/') || isOrderPath(path);
}

function isOrderPath(path: string): boolean {
  const segments = path.split('/');
  return segments.length === 4 && segments[1] === 'store' && segments[2] === 'orders';
}

type QueryValue = string | number | boolean | undefined | null;

export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, QueryValue>,
): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export class StoreApiClient {
  readonly #baseUrl: string;
  readonly #publishableKey: string;
  readonly #fetch: typeof fetch;

  constructor(config: StoreApiConfig) {
    this.#baseUrl = config.baseUrl;
    this.#publishableKey = config.publishableKey;
    this.#fetch = config.fetchImpl ?? globalThis.fetch;
  }

  async request<T>(
    method: string,
    path: string,
    init: {
      query?: Record<string, QueryValue> | undefined;
      body?: unknown;
      options?: RequestOptions | undefined;
    } = {},
  ): Promise<T> {
    const { query, body, options } = init;
    const headers = new Headers({ accept: 'application/json' });
    headers.set(HEADERS.publishableKey, this.#publishableKey);
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (options?.idempotencyKey) headers.set(HEADERS.idempotencyKey, options.idempotencyKey);
    if (options?.token) {
      if (!allowsCustomerToken(path)) {
        throw new Error(`Refusing to send a customer token to ${path}`);
      }
      headers.set('authorization', `Bearer ${options.token}`);
    }

    const next: NextFetchOptions = {};
    if (options?.tags) next.tags = options.tags;
    if (options?.revalidate !== undefined) next.revalidate = options.revalidate;

    const requestInit: RequestInit & { next?: NextFetchOptions } = { method, headers };
    if (body !== undefined) requestInit.body = JSON.stringify(body);
    if (options?.cache) requestInit.cache = options.cache;
    if (options?.signal) requestInit.signal = options.signal;
    if (Object.keys(next).length > 0) requestInit.next = next;

    const response = await this.#fetch(buildUrl(this.#baseUrl, path, query), requestInit);
    const requestId = response.headers.get(HEADERS.requestId);

    if (!response.ok) {
      throw new StoreApiError(response.status, await readErrorBody(response), requestId);
    }
    if (response.status === 204) return undefined as T;

    try {
      return (await response.json()) as T;
    } catch {
      throw new StoreApiError(response.status, null, requestId, 'Store API returned invalid JSON');
    }
  }

  // ── store ────────────────────────────────────────────────────────────────────────────────────
  getStore(options?: RequestOptions): Promise<Result<'getStore'>> {
    return this.request('GET', '/store', { options });
  }

  // ── catalog ──────────────────────────────────────────────────────────────────────────────────
  listCategories(options?: RequestOptions): Promise<Result<'listCategories'>> {
    return this.request('GET', '/store/categories', { options });
  }

  listProducts(
    query?: Query<'listProducts'>,
    options?: RequestOptions,
  ): Promise<Result<'listProducts'>> {
    return this.request('GET', '/store/products', { query: { ...query }, options });
  }

  getProduct(handle: string, options?: RequestOptions): Promise<Result<'getProduct'>> {
    return this.request('GET', `/store/products/${encodeURIComponent(handle)}`, { options });
  }

  // ── cart ─────────────────────────────────────────────────────────────────────────────────────
  createCart(body: Body<'createCart'>, options?: RequestOptions): Promise<Result<'createCart'>> {
    return this.request('POST', '/store/carts', { body, options });
  }

  getCart(cartId: string, options?: RequestOptions): Promise<Result<'getCart'>> {
    return this.request('GET', `/store/carts/${encodeURIComponent(cartId)}`, { options });
  }

  updateCart(
    cartId: string,
    body: Body<'updateCart'>,
    options?: RequestOptions,
  ): Promise<Result<'updateCart'>> {
    return this.request('PATCH', `/store/carts/${encodeURIComponent(cartId)}`, { body, options });
  }

  addLineItem(
    cartId: string,
    body: Body<'addLineItem'>,
    options?: RequestOptions,
  ): Promise<Result<'addLineItem'>> {
    return this.request('POST', `/store/carts/${encodeURIComponent(cartId)}/line-items`, {
      body,
      options,
    });
  }

  updateLineItem(
    cartId: string,
    lineItemId: string,
    body: Body<'updateLineItem'>,
    options?: RequestOptions,
  ): Promise<Result<'updateLineItem'>> {
    return this.request(
      'PATCH',
      `/store/carts/${encodeURIComponent(cartId)}/line-items/${encodeURIComponent(lineItemId)}`,
      { body, options },
    );
  }

  removeLineItem(
    cartId: string,
    lineItemId: string,
    options?: RequestOptions,
  ): Promise<Result<'removeLineItem'>> {
    return this.request(
      'DELETE',
      `/store/carts/${encodeURIComponent(cartId)}/line-items/${encodeURIComponent(lineItemId)}`,
      { options },
    );
  }

  listShippingOptions(
    cartId: string,
    options?: RequestOptions,
  ): Promise<Result<'listShippingOptions'>> {
    return this.request('GET', `/store/carts/${encodeURIComponent(cartId)}/shipping-options`, {
      options,
    });
  }

  createPaymentSession(
    cartId: string,
    body: Body<'createPaymentSession'>,
    options?: RequestOptions,
  ): Promise<Result<'createPaymentSession'>> {
    return this.request('POST', `/store/carts/${encodeURIComponent(cartId)}/payment-session`, {
      body,
      options,
    });
  }

  completeCart(
    cartId: string,
    idempotencyKey: string,
    options?: RequestOptions,
  ): Promise<Result<'completeCart'>> {
    return this.request('POST', `/store/carts/${encodeURIComponent(cartId)}/complete`, {
      options: { ...options, idempotencyKey },
    });
  }

  // ── orders ───────────────────────────────────────────────────────────────────────────────────
  getOrder(
    orderId: string,
    query: Query<'getOrder'>,
    options?: RequestOptions,
  ): Promise<Result<'getOrder'>> {
    return this.request('GET', `/store/orders/${encodeURIComponent(orderId)}`, {
      query: { ...query },
      options,
    });
  }

  // ── customers (bearer token required) ────────────────────────────────────────────────────────
  registerCustomer(
    body: Body<'registerCustomer'>,
    options: RequestOptions,
  ): Promise<Result<'registerCustomer'>> {
    return this.request('POST', '/store/customers', { body, options });
  }

  getMe(options: RequestOptions): Promise<Result<'getMe'>> {
    return this.request('GET', '/store/customers/me', { options });
  }

  updateMe(body: Body<'updateMe'>, options: RequestOptions): Promise<Result<'updateMe'>> {
    return this.request('PATCH', '/store/customers/me', { body, options });
  }

  listMyAddresses(options: RequestOptions): Promise<Result<'listMyAddresses'>> {
    return this.request('GET', '/store/customers/me/addresses', { options });
  }

  addMyAddress(
    body: Body<'addMyAddress'>,
    options: RequestOptions,
  ): Promise<Result<'addMyAddress'>> {
    return this.request('POST', '/store/customers/me/addresses', { body, options });
  }

  listMyOrders(
    query: Query<'listMyOrders'> | undefined,
    options: RequestOptions,
  ): Promise<Result<'listMyOrders'>> {
    return this.request('GET', '/store/customers/me/orders', { query: { ...query }, options });
  }
}

async function readErrorBody(response: Response): Promise<Record<string, never> | null> {
  try {
    return (await response.json()) as Record<string, never>;
  } catch {
    return null;
  }
}
