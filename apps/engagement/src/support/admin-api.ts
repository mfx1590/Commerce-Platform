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
// The `customer_id` filter on `listOrders` is `CONTRACT CHANGE` #569 — accepted, landed on
// integration/orders-customer-filter (a2e6e98, Admin API 0.4.24), core predicate from window 1. It exists
// because the alternative, `q=<the customer's e-mail>`, puts an address in a URL (every proxy and access log
// then has it) and is a SEARCH rather than a key, so two customers sharing an address would see each other's
// orders. The reasoning is on #569.
//
// `getOrder` already embeds payments, refunds, shipments and returns, so the whole history is one list call
// plus one detail call per order — no new endpoint and no join of ours.
//
// NOTHING IS CACHED. The agent's permission is only true at the moment the core says so, and a cache would
// also be a copy of personal data, which #556 forbids.

import { SupportError } from './types.js';

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

/** The raw shapes this reader takes from the Admin API; only the fields the context uses. */
export interface RawCustomer {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: 'guest' | 'registered' | 'disabled' | 'erased';
  created_at?: string | null;
}

export interface RawOrderSummary {
  id: string;
  display_id: number;
  status: string;
  payment_status: string;
  fulfillment_status: string;
  total?: number | string | null;
  total_minor?: number | string | null;
  currency?: string | null;
  placed_at: string | null;
}

export interface RawOrderDetail extends RawOrderSummary {
  payments?: unknown[];
  refunds?: unknown[];
  shipments?: unknown[];
  returns?: unknown[];
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
        `${base}/admin/stores/${storeId}/customers/${customerId}`,
        authorization,
        'customer',
      );
      if (body === null) return null;
      const c = (body as { customer?: RawCustomer }).customer ?? (body as RawCustomer);
      if (!c || typeof c.id !== 'string') {
        throw new SupportError(502, 'upstream_error', 'Unexpected customer shape');
      }
      return c;
    },

    async listOrders(storeId, customerId, authorization) {
      const url = `${base}/admin/stores/${storeId}/orders?customer_id=${encodeURIComponent(
        customerId,
      )}&sort=placed_at&order=desc&limit=${limit}`;
      const body = await get(url, authorization, 'orders');
      if (body === null) return [];
      const orders = (body as { orders?: RawOrderSummary[] }).orders;
      return Array.isArray(orders) ? orders : [];
    },

    async getOrder(storeId, orderId, authorization) {
      const body = await get(
        `${base}/admin/stores/${storeId}/orders/${orderId}`,
        authorization,
        'order',
      );
      if (body === null) return null;
      const o = (body as { order?: RawOrderDetail }).order ?? (body as RawOrderDetail);
      return o && typeof o.id === 'string' ? o : null;
    },
  };
}
