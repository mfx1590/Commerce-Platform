// Reading the support context from the core Admin API with the AGENT'S OWN token (#556).
//
// Three operations, all read-only, all already in the contract:
//
//   getCustomer   GET /admin/stores/{storeId}/customers/{customerId}   support on store:{storeId}
//   listOrders    GET /admin/stores/{storeId}/orders?customer_id=...   viewer  on store:{storeId}
//   getOrder      GET /admin/stores/{storeId}/orders/{orderId}         viewer  on store:{storeId}
//
// `support` implies `viewer` in the model (`infra/openfga/model.fga`), so one `support` grant covers all three
// and no new permission is needed for this API.
//
// THE RESPONSE TYPES COME FROM THE CONTRACT ITSELF (`@platform/contracts/admin`, generated from
// admin-api.yaml), not from hand-written interfaces. The first version of this file guessed them and got two
// wrong — it read `body.orders` where `listOrders` returns a `Page` of `items`, and treated `total` as a
// scalar where `OrderSummary.total` is `Money { amount_minor, currency }`. Against the real core every
// customer would have shown zero orders and an empty currency, and a fake reader in the tests could never
// have caught it (#573 review). Typing against the generated schemas makes the next such drift a COMPILE
// error rather than a silent empty answer.
//
// The shapes, for the record:
//   * getCustomer -> `Customer` directly (no envelope)
//   * getOrder    -> `Order` directly (no envelope); it embeds payments, refunds, shipments and returns
//   * listOrders  -> `Page` + `{ items: OrderSummary[] }`
//
// `customer_id` on `listOrders` is CONTRACT CHANGE #569 (Admin API 0.4.24, merged as #570). It exists because
// the alternative, `q=<the customer's e-mail>`, puts an address in a URL (every proxy and access log then has
// it) and is a SEARCH rather than a key, so two customers sharing an address would see each other's orders.
//
// NOTHING IS CACHED. The agent's permission is only true at the moment the core says so, and a cache would
// also be a copy of personal data, which #556 forbids.

import type { components } from '@platform/contracts/admin';
import { SupportError } from './types.js';

type Schemas = components['schemas'];

/** `Customer` exactly as the Admin API defines it. */
export type RawCustomer = Schemas['Customer'];
/** One row of `listOrders`' `items`. `total` is `Money`; there is NO top-level currency here. */
export type RawOrderSummary = Schemas['OrderSummary'];
/** `getOrder`'s body: `OrderSummary` plus the embedded arrays, `currency` and `totals`. */
export type RawOrderDetail = Schemas['Order'];
export type RawMoney = Schemas['Money'];

/** `listOrders`' body: the shared `Page` wrapper plus `items`. Note `Page.total` is a COUNT, not money. */
type OrdersPage = Schemas['Page'] & { items: RawOrderSummary[] };

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface SupportReaderOptions {
  /** The core's base URL. */
  baseUrl: string;
  fetchImpl?: FetchLike;
  /** How many of the customer's orders to detail, newest first. Config, because it bounds the fan-out. */
  maxOrders?: number;
}

export interface SupportReader {
  getCustomer(
    storeId: string,
    customerId: string,
    authorization: string,
  ): Promise<RawCustomer | null>;
  listOrders(
    storeId: string,
    customerId: string,
    authorization: string,
  ): Promise<RawOrderSummary[]>;
  getOrder(storeId: string, orderId: string, authorization: string): Promise<RawOrderDetail | null>;
}

/**
 * Every id that reaches a path goes through this. A path segment is not a place to interpolate caller input:
 * an unencoded `%2F..%2F` would climb out of the resource and hit another route with the agent's own token
 * (#573 review). The route validates ids as uuids before calling at all; this is the second line, because a
 * reader must be safe on its own terms.
 */
function segment(value: string): string {
  return encodeURIComponent(value);
}

export function createSupportReader(opts: SupportReaderOptions): SupportReader {
  if (!opts.baseUrl?.trim()) throw new Error('support reader: a base URL is required');
  const base = opts.baseUrl.trim().replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const limit = opts.maxOrders ?? 25;

  async function get(url: string, authorization: string, what: string): Promise<unknown | null> {
    let res: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      res = await doFetch(url, {
        method: 'GET',
        headers: { authorization, accept: 'application/json' },
      });
    } catch {
      throw new SupportError(502, 'upstream_unavailable', `The core did not answer (${what})`);
    }
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) {
      // The core refused the AGENT. Pass that through unchanged rather than turning it into a 500: the agent
      // is being told, correctly, that this is not theirs to see.
      throw new SupportError(
        res.status,
        res.status === 401 ? 'unauthorized' : 'forbidden',
        'The core refused this read',
      );
    }
    if (!res.ok) {
      // Never the body: it is full of personal data.
      throw new SupportError(502, 'upstream_error', `The core answered ${res.status} (${what})`);
    }
    try {
      return await res.json();
    } catch {
      throw new SupportError(502, 'upstream_error', `The core's answer was unreadable (${what})`);
    }
  }

  return {
    async getCustomer(storeId, customerId, authorization) {
      const body = await get(
        `${base}/admin/stores/${segment(storeId)}/customers/${segment(customerId)}`,
        authorization,
        'customer',
      );
      if (body === null) return null;
      // The contract returns `Customer` directly.
      const c = body as RawCustomer;
      if (!c || typeof c.id !== 'string' || typeof c.email !== 'string') {
        throw new SupportError(502, 'upstream_error', 'Unexpected customer shape');
      }
      return c;
    },

    async listOrders(storeId, customerId, authorization) {
      const url =
        `${base}/admin/stores/${segment(storeId)}/orders` +
        `?customer_id=${encodeURIComponent(customerId)}&sort=placed_at&order=desc&limit=${limit}`;
      const body = await get(url, authorization, 'orders');
      if (body === null) return [];
      // `Page` + `items`, per the contract. NOT `orders`.
      const items = (body as OrdersPage | null)?.items;
      return Array.isArray(items) ? items : [];
    },

    async getOrder(storeId, orderId, authorization) {
      const body = await get(
        `${base}/admin/stores/${segment(storeId)}/orders/${segment(orderId)}`,
        authorization,
        'order',
      );
      if (body === null) return null;
      // The contract returns `Order` directly.
      const o = body as RawOrderDetail;
      return o && typeof o.id === 'string' ? o : null;
    },
  };
}
