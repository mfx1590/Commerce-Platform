// Reading customer PII from the core Admin API (#555), and the token provider that authenticates it.
//
// Events carry no personal data (ADR 0003 item 5), so a CRM contact cannot be built from the bus: the name and
// the e-mail are fetched here, with this service's OWN principal and the least permission that does the job.
// `REQUEST: crm-sync service client` is #565, accepted and routed to window 2: a confidential `staff` client
// with an audience mapper to `core-api`, a `staff_user` row for its subject, and `support` on each synced store
// (per store, not on the organization).
//
// Until that lands, the token comes from an injected `TokenProvider` — which is why this module takes one
// rather than reading the environment itself. `mockTokenProvider` is what the tests and `pnpm dev` use, and
// the live provider will exchange client credentials for a token. This service NEVER stores a token: the
// provider owns any caching, so a rotated secret takes effect without a restart of ours.
//
// Only two operations are called, both read-only: `listCustomers` and `getCustomer`, each
// `x-permission: { relation: support, object: 'store:{storeId}' }`.

import { CrmError, type AdminCustomer, type TokenProvider } from './types.js';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * A fixed-token provider for tests and local runs. It is deliberately NOT a silent default anywhere: the
 * config asks for it by name, so nothing can reach production thinking it has a real principal.
 */
export function mockTokenProvider(token = 'mock-staff-token-words-only'): TokenProvider {
  return { name: 'mock', token: async () => token };
}

export interface AdminApiOptions {
  /** The core's base URL, e.g. `http://localhost:9000`. */
  baseUrl: string;
  tokens: TokenProvider;
  fetchImpl?: FetchLike;
}

export interface CustomerReader {
  /** `getCustomer`. `null` when the core answers 404 — an erased or vanished customer is not an error. */
  getCustomer(storeId: string, customerId: string): Promise<AdminCustomer | null>;
}

export function createAdminApiReader(opts: AdminApiOptions): CustomerReader {
  if (!opts.baseUrl?.trim()) throw new Error('admin api: a base URL is required');
  const base = opts.baseUrl.trim().replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  return {
    async getCustomer(storeId, customerId) {
      const token = await opts.tokens.token();
      const url = `${base}/admin/stores/${storeId}/customers/${customerId}`;
      let res: { ok: boolean; status: number; json(): Promise<unknown> };
      try {
        res = await doFetch(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : 'Error';
        throw new CrmError(`admin api: request failed ${name}`, { retryable: true });
      }
      // 404 is an answer, not a failure: the customer is gone (erased, or never existed in this store).
      if (res.status === 404) return null;
      if (!res.ok) {
        // 401/403 means the service principal is wrong or unseeded (#565) — worth retrying, because it is
        // usually a deployment ordering problem rather than a permanent refusal.
        throw new CrmError(`admin api: HTTP ${res.status}`, {
          retryable:
            res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403,
        });
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new CrmError('admin api: unreadable response', { retryable: true });
      }
      const customer =
        (body as { customer?: AdminCustomer } | null)?.customer ?? (body as AdminCustomer | null);
      if (!customer || typeof customer.id !== 'string' || typeof customer.email !== 'string') {
        // Never echo the body: it is the one payload in this service that is full of personal data.
        throw new CrmError('admin api: unexpected customer shape');
      }
      return {
        id: customer.id,
        email: customer.email,
        first_name: customer.first_name ?? null,
        last_name: customer.last_name ?? null,
        status: customer.status,
      };
    },
  };
}
