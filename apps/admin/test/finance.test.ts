/**
 * HQ › Finance (#851): the Accounting API's reads are refused below `finance` on organization:hq
 * BEFORE any request; the URL comes from ACCOUNTING_API_URL (never a mock in production); the
 * page's search params become only the declared query parameters; balances stay per currency.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrincipalKey } from './fixtures/principals';
import type * as EnvModule from '@/lib/env';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/current-session', () => ({
  getSession: async () => ({ accessToken: 'session-access-token' }),
}));
const config = vi.hoisted(() => ({ accountingApiUrl: 'http://accounting.test' as string | null }));
vi.mock('@/lib/env', async (importOriginal) => {
  const real = await importOriginal<typeof EnvModule>();
  return {
    ...real,
    env: new Proxy(real.env, {
      get: (target, key) =>
        key === 'accountingApiUrl' ? config.accountingApiUrl : Reflect.get(target, key),
    }),
  };
});
const principalOf = vi.hoisted(() => ({ current: 'finance' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals[principalOf.current as PrincipalKey],
  }),
}));
const client = vi.hoisted(() => ({ accountingRequest: vi.fn() }));
vi.mock('@/lib/api/accounting-client', () => client);

const accounting = await import('@/lib/api/accounting');
const { resolveAccountingApiUrl } = await import('@/lib/env');
const {
  readFinanceView,
  financeHref,
  balanceByCurrency,
  currenciesWithoutTotals,
  referenceHref,
  isoDate,
} = await import('@/lib/finance');

const ENTITY = '00000000-0000-4000-8000-000000000011';

beforeEach(() => {
  client.accountingRequest.mockReset();
  client.accountingRequest.mockResolvedValue({ ok: true, status: 200, data: { items: [] } });
  principalOf.current = 'finance';
  config.accountingApiUrl = 'http://accounting.test';
});

describe('the finance gate (before any API call)', () => {
  it.each(['storeAdmin', 'storeStaff', 'analyst', 'support', 'operations', 'unassigned'] as const)(
    '%s is refused with the contract 403 and nothing is requested',
    async (role) => {
      principalOf.current = role;
      for (const call of [
        () => accounting.listLegalEntityBooks(),
        () => accounting.getTrialBalance(ENTITY, {}),
        () => accounting.listJournalLines(ENTITY, {}),
      ]) {
        expect(await call()).toEqual(accounting.FINANCE_REFUSAL);
      }
      expect(client.accountingRequest).not.toHaveBeenCalled();
    },
  );

  it.each(['finance', 'owner'] as const)(
    '%s reaches the service with the session token',
    async (role) => {
      principalOf.current = role;
      await accounting.getTrialBalance(ENTITY, { from: '2026-10-01', currency: 'JPY' });
      expect(client.accountingRequest).toHaveBeenCalledWith({
        baseUrl: 'http://accounting.test',
        path: `/accounting/v1/legal-entities/${ENTITY}/trial-balance`,
        query: { from: '2026-10-01', currency: 'JPY' },
        accessToken: 'session-access-token',
      });
    },
  );

  it('not configured is its own failure, not an empty list', async () => {
    config.accountingApiUrl = null;
    expect(await accounting.listLegalEntityBooks()).toEqual(accounting.NOT_CONFIGURED);
    expect(client.accountingRequest).not.toHaveBeenCalled();
  });
});

describe('ACCOUNTING_API_URL', () => {
  it('the real URL wins, then the mock variable; trailing slash dropped', () => {
    expect(resolveAccountingApiUrl({ ACCOUNTING_API_URL: 'http://127.0.0.1:9003/' })).toBe(
      'http://127.0.0.1:9003',
    );
    expect(resolveAccountingApiUrl({ MOCK_ACCOUNTING_API_URL: 'http://127.0.0.1:4113' })).toBe(
      'http://127.0.0.1:4113',
    );
  });
  it('development falls back to `pnpm mock` (:4013); production never does', () => {
    expect(resolveAccountingApiUrl({})).toBe('http://localhost:4013');
    expect(resolveAccountingApiUrl({ NODE_ENV: 'production' })).toBeNull();
  });
  it('production never honours MOCK_ACCOUNTING_API_URL (#853 review)', () => {
    expect(
      resolveAccountingApiUrl({
        NODE_ENV: 'production',
        MOCK_ACCOUNTING_API_URL: 'http://127.0.0.1:4013',
      }),
    ).toBeNull();
    expect(
      resolveAccountingApiUrl({
        NODE_ENV: 'production',
        ACCOUNTING_API_URL: 'http://accounting:9003',
        MOCK_ACCOUNTING_API_URL: 'http://127.0.0.1:4013',
      }),
    ).toBe('http://accounting:9003');
  });
  it('a malformed URL fails loudly with the variable named', () => {
    expect(() => resolveAccountingApiUrl({ ACCOUNTING_API_URL: 'accounting:9003' })).toThrow(
      /ACCOUNTING_API_URL/,
    );
  });
});

describe('readFinanceView', () => {
  it('keeps only declared, well-formed parameters', () => {
    const view = readFinanceView({
      entity: ENTITY,
      tab: 'journal',
      from: '2026-10-01',
      to: '2026-10-31',
      currency: 'JPY',
      journal: 'sales',
      account_code: '1200',
      reference_type: 'order',
      reference_id: '00000000-0000-4000-8000-00000000c001',
      erp: 'unposted',
      page: '2',
      evil: 'x',
    });
    expect(view).toMatchObject({ entity: ENTITY, tab: 'journal', currency: 'JPY', ignored: [] });
    expect(view.journal).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
      currency: 'JPY',
      page: 2,
      journal: 'sales',
      account_code: '1200',
      reference_type: 'order',
      reference_id: '00000000-0000-4000-8000-00000000c001',
      erp: 'unposted',
    });
  });

  it('drops and names what is malformed, never sends it', () => {
    const view = readFinanceView({
      entity: 'nope',
      tab: 'payroll',
      from: '2026-02-30',
      currency: 'yen',
      journal: 'misc',
      reference_id: '1; drop',
      page: '0',
    });
    expect(view.entity).toBeNull();
    expect(view.tab).toBe('trial-balance');
    expect(view.journal).toEqual({});
    expect(view.ignored.sort()).toEqual(
      ['currency', 'entity', 'from', 'journal', 'page', 'reference_id'].sort(),
    );
  });

  it('a "to" before "from" is ignored', () => {
    const view = readFinanceView({ from: '2026-10-31', to: '2026-10-01' });
    expect(view.period).toEqual({ from: '2026-10-31' });
    expect(view.ignored).toEqual(['to']);
  });

  it('isoDate accepts real calendar days only', () => {
    expect(isoDate('2026-02-28')).toBe('2026-02-28');
    expect(isoDate('2026-02-29')).toBeUndefined();
    expect(isoDate('26-02-01')).toBeUndefined();
  });
});

describe('per-currency helpers', () => {
  it('balanceByCurrency never adds currencies together', () => {
    expect(
      balanceByCurrency({
        legal_entity_id: ENTITY,
        from: null,
        to: null,
        rows: [],
        totals: [
          { currency: 'EUR', debit_minor: 4512300, credit_minor: 4512300, difference_minor: 0 },
          { currency: 'JPY', debit_minor: 198000, credit_minor: 196020, difference_minor: 1980 },
        ],
      }),
    ).toEqual([
      {
        currency: 'EUR',
        debit_minor: 4512300,
        credit_minor: 4512300,
        difference_minor: 0,
        balanced: true,
      },
      {
        currency: 'JPY',
        debit_minor: 198000,
        credit_minor: 196020,
        difference_minor: 1980,
        balanced: false,
      },
    ]);
  });

  it('balanced needs debit = credit, not a zero difference alone (#853 review)', () => {
    const [eur] = balanceByCurrency({
      legal_entity_id: ENTITY,
      from: null,
      to: null,
      rows: [],
      totals: [{ currency: 'EUR', debit_minor: 500, credit_minor: 400, difference_minor: 0 }],
    });
    expect(eur?.balanced).toBe(false);
  });

  it('currencies with rows but no total are named, in row order', () => {
    const row = (currency: string, account_code: string) => ({
      currency,
      account_code,
      account_name: 'x',
      account_type: 'asset' as const,
      debit_minor: 1,
      credit_minor: 0,
      balance_minor: 1,
    });
    expect(
      currenciesWithoutTotals({
        legal_entity_id: ENTITY,
        from: null,
        to: null,
        rows: [row('JPY', '1200'), row('EUR', '1200'), row('USD', '1200'), row('JPY', '4000')],
        totals: [{ currency: 'EUR', debit_minor: 1, credit_minor: 1, difference_minor: 0 }],
      }),
    ).toEqual(['JPY', 'USD']);
  });

  it('an order reference opens the store order; others have no page', () => {
    const store = '00000000-0000-4000-8000-000000000031';
    const order = '00000000-0000-4000-8000-00000000c001';
    expect(referenceHref({ store_id: store, reference_type: 'order', reference_id: order })).toBe(
      `/${store}/orders/${order}`,
    );
    expect(
      referenceHref({ store_id: store, reference_type: 'payout', reference_id: order }),
    ).toBeNull();
    expect(
      referenceHref({ store_id: null, reference_type: 'order', reference_id: order }),
    ).toBeNull();
  });

  it('financeHref keeps the entity and tab, drops empty params', () => {
    expect(
      financeHref({ entity: ENTITY, tab: 'journal' }, { page: 3, currency: undefined, erp: '' }),
    ).toBe(`/finance?entity=${ENTITY}&tab=journal&page=3`);
  });
});
