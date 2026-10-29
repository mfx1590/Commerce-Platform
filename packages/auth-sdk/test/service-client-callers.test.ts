// The allowlist against its CALLERS (#632, Fable review of #635): analytics-sync's list must be exactly the
// operations the #602 reconcile clients call (apps/analytics-ingest, through its public API) — an under-grant 403s
// every real-token run, an over-grant widens a leaked secret. Each client method runs with a recording fetch; every
// URL it asks for is resolved by the contract operation matcher over the real contract of its API. Pure: no stack.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  createAdminReportsClient,
  createFinanceClient,
  type Fetch,
} from '@platform/analytics-ingest';
import {
  SERVICE_CLIENT_OPERATIONS,
  createOperationMatcher,
  type ServiceApi,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const matcherOf = (file: string) =>
  createOperationMatcher(
    (
      parse(readFileSync(resolve(here, '../../contracts/openapi', file), 'utf8')) as {
        paths: Record<string, Record<string, unknown>>;
      }
    ).paths,
  );
const MATCHERS = { admin: matcherOf('admin-api.yaml'), finance: matcherOf('accounting.yaml') };
const BASE = 'http://reconcile.invalid';

/** Every operation a client's methods call, resolved on its API's contract (an unresolved URL fails the test). */
async function operationsCalled(
  api: ServiceApi,
  run: (fetch: Fetch) => Promise<unknown>[],
): Promise<string[]> {
  const urls: string[] = [];
  const fetch: Fetch = async (url) => {
    urls.push(url);
    // One answer fits every reconcile read: an empty page, an empty listing, a report with no rows.
    return { status: 200, json: async () => ({ items: [], total: 0 }) };
  };
  await Promise.all(run(fetch));
  expect(urls.length).toBeGreaterThan(0);
  const ops = urls.map((url) => {
    const m = MATCHERS[api].match('GET', url.slice(BASE.length));
    expect(m, url).not.toBeNull();
    return m!.operationId;
  });
  return [...new Set(ops)].sort();
}

describe('analytics-sync: the allowlist is exactly what the #602 reconcile clients call', () => {
  it('Finance API', async () => {
    const called = await operationsCalled('finance', (fetch) => {
      const c = createFinanceClient({ baseUrl: BASE, token: 'probe', fetch });
      return [
        c.legalEntities(),
        c.journalLines('le-1', '2026-10-01', '2026-11-01'),
        c.trialBalance('le-1', '2026-10-01', '2026-11-01'),
        c.parkedEvents('le-1'),
        c.payouts('le-1', '2026-10-01', '2026-11-01'),
      ];
    });
    expect(called).toEqual([...SERVICE_CLIENT_OPERATIONS['analytics-sync']!.finance].sort());
    expect(called).toContain('listLegalEntityBooks'); // the reconcile's FIRST call (the review's under-grant)
  });

  it('Admin API', async () => {
    const called = await operationsCalled('admin', (fetch) => {
      const c = createAdminReportsClient({ baseUrl: BASE, token: 'probe', fetch });
      return [c.sales('2026-10-01', '2026-11-01'), c.finance('2026-10-01', '2026-11-01')];
    });
    expect(called).toEqual([...SERVICE_CLIENT_OPERATIONS['analytics-sync']!.admin].sort());
  });

  it('every client method is walked: a new reconcile read fails here until it is allowlisted or refused', () => {
    const methods = (o: object) => Object.keys(o).sort();
    const opts = { baseUrl: BASE, token: 'probe' };
    expect(methods(createFinanceClient(opts))).toEqual(
      ['journalLines', 'legalEntities', 'parkedEvents', 'payouts', 'trialBalance'].sort(),
    );
    expect(methods(createAdminReportsClient(opts))).toEqual(['finance', 'sales']);
  });
});

describe('crm-sync: getCustomer only (the CRM sync calls nothing else; listCustomers dropped in review)', () => {
  it('the list', () => {
    expect(SERVICE_CLIENT_OPERATIONS['crm-sync']).toEqual({ admin: ['getCustomer'], finance: [] });
  });
});
