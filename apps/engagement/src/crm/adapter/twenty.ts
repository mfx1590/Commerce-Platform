// The Twenty adapter (#555). Twenty is the open-source, self-hostable CRM the issue names first; HubSpot would
// be a second file behind the same interface.
//
// NOT exercised against a real instance — none exists. Live use is on the launch checklist. So this is built
// to be read and tested: the API key never leaves the object, a refusal is reduced to a status and an error
// name, and the request shape is asserted against an injected fetch.
//
// UPSERT BY OUR CUSTOMER ID, NEVER BY E-MAIL (#555). Twenty's REST API has no "upsert" verb, so the adapter
// does the only correct thing: find the person whose external-id field equals our customer id, then PATCH that
// one or POST a new one. The filter is on `externalId`, so two customers who share an e-mail address stay two
// contacts, and a customer who changes address stays one.

import { CrmError, type CrmAdapter, type CrmContact } from '../types.js';

/** The slice of `fetch` this adapter uses, so a test injects one instead of opening a socket. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export interface TwentyOptions {
  /** The Twenty REST base, e.g. `https://crm.example/rest`. */
  baseUrl: string;
  /** The API key. Environment only (`TWENTY_API_KEY`); never a default, never logged. */
  apiKey: string;
  /**
   * The field on Twenty's `person` object holding our customer id. Configurable because it is a custom field
   * someone creates in their workspace, and a wrong guess here would silently create duplicate people.
   */
  externalIdField?: string;
  fetchImpl?: FetchLike;
}

interface TwentyPerson {
  id: string;
}

export class TwentyCrmAdapter implements CrmAdapter {
  readonly name = 'twenty';
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #field: string;
  readonly #fetch: FetchLike;

  constructor(opts: TwentyOptions) {
    if (!opts.apiKey?.trim()) throw new Error('twenty: TWENTY_API_KEY is required');
    if (!opts.baseUrl?.trim()) throw new Error('twenty: a base URL is required');
    this.#baseUrl = opts.baseUrl.trim().replace(/\/+$/, '');
    this.#apiKey = opts.apiKey.trim();
    this.#field = opts.externalIdField ?? 'externalId';
    this.#fetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async upsert(contact: CrmContact): Promise<void> {
    const existing = await this.#findByExternalId(contact.externalId);
    const body = JSON.stringify(this.#personBody(contact));
    if (existing) {
      // A 404 here means the person was deleted between the lookup and the PATCH. Retryable, not fatal: the
      // SDK re-runs the handler, the next lookup finds nothing and it POSTs instead (#568 review).
      await this.#send(`${this.#baseUrl}/people/${existing.id}`, 'PATCH', body, 'upsert', {
        on404: 'retryable',
      });
      return;
    }
    await this.#send(`${this.#baseUrl}/people`, 'POST', body, 'upsert');
  }

  async remove(externalId: string): Promise<void> {
    const existing = await this.#findByExternalId(externalId);
    // Idempotent by contract: a contact already gone is a success. An erasure must not fail a second time.
    if (!existing) return;
    // ...and the same holds for the race: the lookup found a person, something deleted it before our DELETE
    // landed, and the outcome we wanted has happened. A 404 is success, not an error (#568 review).
    await this.#send(`${this.#baseUrl}/people/${existing.id}`, 'DELETE', undefined, 'remove', {
      on404: 'success',
    });
  }

  /** Twenty's person shape. `name` is a composite field; the rollup goes to custom number/date fields. */
  #personBody(contact: CrmContact): Record<string, unknown> {
    return {
      [this.#field]: contact.externalId,
      emails: { primaryEmail: contact.email },
      name: { firstName: contact.firstName ?? '', lastName: contact.lastName ?? '' },
      storeCode: contact.storeCode,
      ordersCount: contact.ordersCount,
      netRevenueMinor: contact.netRevenueMinor,
      revenueCurrency: contact.currency,
      ...(contact.lastOrderAt ? { lastOrderAt: contact.lastOrderAt } : {}),
    };
  }

  async #findByExternalId(externalId: string): Promise<TwentyPerson | null> {
    // The id is a uuid of ours, so it needs no escaping beyond the query encoding.
    const filter = encodeURIComponent(`${this.#field}[eq]:${externalId}`);
    const res = await this.#request(`${this.#baseUrl}/people?filter=${filter}&limit=1`, 'GET');
    if (!res.ok) {
      throw new CrmError(`twenty find: HTTP ${res.status}`, {
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new CrmError('twenty find: unreadable response', { retryable: true });
    }
    const people = (body as { data?: { people?: TwentyPerson[] } } | null)?.data?.people;
    return Array.isArray(people) && people[0] ? people[0] : null;
  }

  async #send(
    url: string,
    method: string,
    body: string | undefined,
    what: string,
    opts: { on404?: 'success' | 'retryable' } = {},
  ): Promise<void> {
    const res = await this.#request(url, method, body);
    if (res.ok) return;
    if (res.status === 404 && opts.on404 === 'success') return;
    throw new CrmError(`twenty ${what}: HTTP ${res.status}`, {
      retryable:
        res.status === 429 ||
        res.status >= 500 ||
        (res.status === 404 && opts.on404 === 'retryable'),
    });
  }

  async #request(
    url: string,
    method: string,
    body?: string,
  ): Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }> {
    try {
      return await this.#fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body }),
      });
    } catch (err) {
      // A fetch failure's message can carry the URL, and a URL can carry a credential: the class only.
      const name = err instanceof Error ? err.name : 'Error';
      throw new CrmError(`twenty request: failed ${name}`, { retryable: true });
    }
  }
}
