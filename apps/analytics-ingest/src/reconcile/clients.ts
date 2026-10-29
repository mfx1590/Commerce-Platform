// The two public APIs `reconcile` reads, over HTTP with a bearer token: the Finance API (apps/accounting,
// packages/contracts/openapi/accounting.yaml) and the core's HQ report operations (admin-api.yaml). Nothing here reads
// another module's tables. Types come from the generated contracts, so a contract change breaks the build, not the
// money gate.
//
// Note the two date conventions: Admin API reports take `[from, to)` (to EXCLUSIVE); the Finance API takes
// `[from, to]` (to INCLUSIVE). The clients take the reconcile window `[from, to)` and translate.
import type { AccountingComponents, AdminComponents } from '@platform/contracts';

export type JournalLine = AccountingComponents['schemas']['JournalLine'];
export type LegalEntityBooks = AccountingComponents['schemas']['LegalEntityBooks'];
export type ParkedEvent = AccountingComponents['schemas']['ParkedEvent'];
export type Payout = AccountingComponents['schemas']['Payout'];
export type TrialBalance = AccountingComponents['schemas']['TrialBalance'];
export type SalesReport = AdminComponents['schemas']['SalesReport'];
export type FinanceReport = AdminComponents['schemas']['FinanceReport'];

export class ApiReadError extends Error {
  constructor(
    readonly api: 'finance' | 'admin',
    readonly status: number,
    readonly path: string,
    readonly code: string | undefined,
  ) {
    super(`${api} API ${path} answered ${status}${code ? ` (${code})` : ''}`);
    this.name = 'ApiReadError';
  }
}

export type Fetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export interface ApiOptions {
  baseUrl: string;
  /** A bearer token: a real staff token on the dev stack, the service client once window 2 ships it. */
  token: string;
  fetch?: Fetch;
}

function getter(api: 'finance' | 'admin', o: ApiOptions) {
  const doFetch: Fetch = o.fetch ?? ((url, init) => fetch(url, init));
  const base = o.baseUrl.replace(/\/$/, '');
  return async <T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<T> => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
    const full = `${path}${qs.size > 0 ? `?${qs.toString()}` : ''}`;
    const res = await doFetch(`${base}${full}`, {
      headers: { authorization: `Bearer ${o.token}`, accept: 'application/json' },
    });
    const body = await res.json().catch(() => undefined);
    if (res.status !== 200)
      throw new ApiReadError(api, res.status, path, (body as { code?: string } | undefined)?.code);
    return body as T;
  };
}

/** `[from, to)` → the inclusive last day the Finance API wants. */
export function inclusiveEnd(toExclusive: string): string {
  const d = new Date(`${toExclusive}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const PAGE = 100; // the contract's maximum

export function createFinanceClient(o: ApiOptions) {
  const get = getter('finance', o);
  async function all<T>(path: string, query: Record<string, string | undefined>): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const r = await get<{ items: T[]; total: number }>(path, { ...query, page, limit: PAGE });
      out.push(...r.items);
      if (r.items.length === 0 || out.length >= r.total) return out;
    }
  }
  const le = (id: string) => `/accounting/v1/legal-entities/${encodeURIComponent(id)}`;
  return {
    async legalEntities(): Promise<LegalEntityBooks[]> {
      return (await get<{ items: LegalEntityBooks[] }>('/accounting/v1/legal-entities')).items;
    },
    journalLines(legalEntityId: string, from: string, toExclusive: string): Promise<JournalLine[]> {
      return all<JournalLine>(`${le(legalEntityId)}/journal-lines`, {
        from,
        to: inclusiveEnd(toExclusive),
      });
    },
    trialBalance(legalEntityId: string, from: string, toExclusive: string): Promise<TrialBalance> {
      return get<TrialBalance>(`${le(legalEntityId)}/trial-balance`, {
        from,
        to: inclusiveEnd(toExclusive),
      });
    },
    parkedEvents(legalEntityId: string): Promise<ParkedEvent[]> {
      return all<ParkedEvent>(`${le(legalEntityId)}/parked-events`, {});
    },
    payouts(legalEntityId: string, from: string, toExclusive: string): Promise<Payout[]> {
      return all<Payout>(`${le(legalEntityId)}/payouts`, { from, to: inclusiveEnd(toExclusive) });
    },
  };
}
export type FinanceClient = ReturnType<typeof createFinanceClient>;

export function createAdminReportsClient(o: ApiOptions) {
  const get = getter('admin', o);
  return {
    /** `getHqSalesReport` (analyst on organization:hq). */
    sales(from: string, toExclusive: string): Promise<SalesReport> {
      return get<SalesReport>('/admin/hq/reports/sales', { from, to: toExclusive });
    },
    /** `getHqFinanceReport` (finance on organization:hq): per store and currency over the window, no day. */
    finance(from: string, toExclusive: string): Promise<FinanceReport> {
      return get<FinanceReport>('/admin/hq/reports/finance', { from, to: toExclusive });
    },
  };
}
export type AdminReportsClient = ReturnType<typeof createAdminReportsClient>;
