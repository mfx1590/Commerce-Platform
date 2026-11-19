/**
 * HQ › Finance, the page itself (#851, #853 review): the placeholder is gone, and every failure of
 * the accounting service is named as the ACCOUNTING service with its own next step — never "Could
 * not reach the Admin API", never an empty table. Down (status 0), not configured, 401, 403, 5xx.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/components/shell/section-guard', () => ({
  HqSectionGuard: ({ children }: { children: React.ReactNode }) => children,
}));
const api = vi.hoisted(() => ({
  listLegalEntityBooks: vi.fn(),
  getTrialBalance: vi.fn(),
  listJournalLines: vi.fn(),
  listPayouts: vi.fn(),
  getPayout: vi.fn(),
  listParkedEvents: vi.fn(),
  getErpSyncStatus: vi.fn(),
}));
vi.mock('@/lib/api/accounting', () => api);

const { default: FinancePage } = await import('@/app/(hq)/finance/page');
const { default: PayoutPage } = await import('@/app/(hq)/finance/payouts/[payoutId]/page');

const ENTITY = '00000000-0000-4000-8000-000000000011';
const books = {
  ok: true,
  status: 200,
  data: {
    items: [
      {
        legal_entity_id: ENTITY,
        code: 'le-brand-a',
        name: 'Brand A B.V.',
        reporting_currency: 'EUR',
        currencies: ['EUR'],
        entries: 10,
        unposted_entries: 2,
        first_entry_date: '2026-10-01',
        last_entry_date: '2026-10-28',
        odoo_company_id: 1,
      },
    ],
  },
};
const failure = (status: number, code: string, message = 'refused') => ({
  ok: false,
  status,
  error: { code, message },
});

async function renderPage(params: Record<string, string> = {}) {
  render(await FinancePage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listLegalEntityBooks.mockReset();
  api.getTrialBalance.mockReset();
  api.listJournalLines.mockReset();
  api.listLegalEntityBooks.mockResolvedValue(books);
  api.getTrialBalance.mockResolvedValue({
    ok: true,
    status: 200,
    data: {
      legal_entity_id: ENTITY,
      from: null,
      to: null,
      rows: [],
      totals: [{ currency: 'EUR', debit_minor: 100, credit_minor: 100, difference_minor: 0 }],
    },
  });
});

describe('FinancePage', () => {
  it('is no longer the placeholder: the books and the first entity’s trial balance', async () => {
    await renderPage();
    expect(document.body.textContent).not.toMatch(/window 15|Phase 4/);
    expect(screen.getByRole('table', { name: 'Legal entities' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Trial balance EUR' })).toHaveTextContent('Balanced');
    expect(api.getTrialBalance).toHaveBeenCalledWith(ENTITY, {});
    expect(api.listJournalLines).not.toHaveBeenCalled();
  });

  it('accounting down (no answer): names the accounting service, never the Admin API', async () => {
    api.listLegalEntityBooks.mockResolvedValue(failure(0, 'network_error', 'fetch failed'));
    await renderPage();
    expect(screen.getByText('Could not reach the accounting service')).toBeInTheDocument();
    expect(screen.getByText(/apps\/accounting is running/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Admin API|pnpm mock/);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('not configured (production without ACCOUNTING_API_URL): says what to set', async () => {
    api.listLegalEntityBooks.mockResolvedValue(
      failure(503, 'not_configured', 'The accounting service is not configured'),
    );
    await renderPage();
    expect(screen.getByText('The accounting service is not configured')).toBeInTheDocument();
    expect(document.body.textContent).toContain('ACCOUNTING_API_URL');
    expect(document.body.textContent).not.toMatch(/Admin API|usually temporary/i);
  });

  it('401 from the accounting service: its own words and a sign-in', async () => {
    api.listLegalEntityBooks.mockResolvedValue(failure(401, 'unauthorized', 'Invalid token'));
    await renderPage();
    expect(
      screen.getByText('The accounting service did not accept this session'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
      'href',
      '/api/auth/login',
    );
    expect(document.body.textContent).not.toContain('Admin API');
  });

  it('403: the forbidden panel with the finance relation named', async () => {
    api.listLegalEntityBooks.mockResolvedValue({
      ok: false,
      status: 403,
      error: {
        code: 'forbidden',
        message: 'requires finance on organization:hq',
        details: { relation: 'finance', object: 'organization:hq' },
      },
    });
    await renderPage();
    expect(screen.getByText('You do not have access to this')).toBeInTheDocument();
    expect(document.body.textContent).toContain('finance on organization:hq');
  });

  it('5xx on one panel (the trial balance) keeps the books and names the service', async () => {
    api.getTrialBalance.mockResolvedValue(failure(503, 'unavailable', 'OpenFGA unreachable'));
    await renderPage();
    expect(screen.getByRole('table', { name: 'Legal entities' })).toBeInTheDocument();
    expect(screen.getByText('The accounting service answered 503')).toBeInTheDocument();
    expect(document.body.textContent).toContain(
      'The trial balance cannot be shown. OpenFGA unreachable',
    );
  });
});

describe('FinancePage, part 2 tabs', () => {
  it('payouts: only listPayouts is called, and its failure names the accounting service', async () => {
    api.listPayouts.mockResolvedValue(failure(0, 'network_error', 'fetch failed'));
    await renderPage({ entity: ENTITY, tab: 'payouts', currency: 'EUR', status: 'discrepant' });
    expect(api.listPayouts).toHaveBeenCalledWith(ENTITY, { status: 'discrepant' });
    expect(api.getTrialBalance).not.toHaveBeenCalled();
    expect(screen.getByText('Could not reach the accounting service')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Admin API');
  });

  it('ops: ERP status and parked events are both read; a 503 on one is named', async () => {
    api.getErpSyncStatus.mockResolvedValue(failure(503, 'unavailable', 'OpenFGA unreachable'));
    api.listParkedEvents.mockResolvedValue({
      ok: true,
      status: 200,
      data: { page: 1, limit: 20, total: 0, items: [] },
    });
    await renderPage({ entity: ENTITY, tab: 'ops' });
    expect(api.getErpSyncStatus).toHaveBeenCalledWith(ENTITY);
    expect(screen.getByText('The accounting service answered 503')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Parked events' })).toHaveTextContent(
      'Nothing is parked',
    );
  });
});

describe('the payout page', () => {
  const PAYOUT = '00000000-0000-4000-8000-00000000d001';
  const renderPayout = async (search: Record<string, string>) =>
    render(
      await PayoutPage({
        params: Promise.resolve({ payoutId: PAYOUT }),
        searchParams: Promise.resolve(search),
      }),
    );

  it('without a valid entity nothing is requested', async () => {
    await renderPayout({ entity: 'nope' });
    expect(api.getPayout).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('That is not a payout of a legal entity');
  });

  it('not configured is named on the payout page too', async () => {
    api.getPayout.mockResolvedValue(failure(503, 'not_configured', 'not configured'));
    await renderPayout({ entity: ENTITY });
    expect(api.getPayout).toHaveBeenCalledWith(ENTITY, PAYOUT, {});
    expect(screen.getByText('The accounting service is not configured')).toBeInTheDocument();
  });
});
