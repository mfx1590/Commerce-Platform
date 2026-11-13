/**
 * HQ › Finance panels (#851): JPY is whole yen (Brand D K.K.), each currency is its own table with
 * its own total and balanced/unbalanced state, an empty period is never called balanced, and a
 * journal order reference opens the store's order.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EntityList, JournalPanel, TrialBalancePanel } from '@/app/(hq)/finance/finance-panels';
import type { JournalLinePage, TrialBalance } from '@/lib/api/accounting-client';
import { readFinanceView } from '@/lib/finance';

const BRAND_D = '00000000-0000-4000-8000-0000000000d1';
const STORE_D = '9f3c3c2a-42a5-4903-bb1d-fd47e4f6324e';
const ORDER = '848ec7e3-0000-4000-8000-000000000001';

const jpyAndEur: TrialBalance = {
  legal_entity_id: BRAND_D,
  from: '2026-11-01',
  to: '2026-11-30',
  rows: [
    {
      currency: 'JPY',
      account_code: '1200',
      account_name: 'Accounts receivable — trade',
      account_type: 'asset',
      debit_minor: 1980,
      credit_minor: 0,
      balance_minor: 1980,
    },
    {
      currency: 'JPY',
      account_code: '4000',
      account_name: 'Revenue — goods',
      account_type: 'revenue',
      debit_minor: 0,
      credit_minor: 1980,
      balance_minor: -1980,
    },
    {
      currency: 'EUR',
      account_code: '4000',
      account_name: 'Revenue — goods',
      account_type: 'revenue',
      debit_minor: 0,
      credit_minor: 495,
      balance_minor: -495,
    },
  ],
  totals: [
    { currency: 'JPY', debit_minor: 1980, credit_minor: 1980, difference_minor: 0 },
    { currency: 'EUR', debit_minor: 0, credit_minor: 495, difference_minor: -495 },
  ],
};

describe('TrialBalancePanel', () => {
  it('JPY renders whole yen; each currency its own table, total and state; nothing summed across', () => {
    render(<TrialBalancePanel trialBalance={jpyAndEur} />);
    const jpy = screen.getByRole('region', { name: 'Trial balance JPY' });
    expect(within(jpy).getByText('Balanced')).toBeInTheDocument();
    // JP¥1,980 (en-GB) — never ¥19.80 (minor units are whole yen) and no decimals.
    expect(within(jpy).getAllByText(/^(JP)?¥1,980$/).length).toBeGreaterThan(0);
    expect(jpy.textContent).not.toMatch(/¥19\.80|¥1,980\.00/);
    expect(within(jpy).queryByText(/€/)).toBeNull();

    const eur = screen.getByRole('region', { name: 'Trial balance EUR' });
    expect(within(eur).getByText('Unbalanced by €4.95')).toBeInTheDocument();
    // No cross-currency figure anywhere: 1980 + 495 = 2475 never appears.
    expect(document.body.textContent).not.toMatch(/2,475|24\.75/);
  });

  it('a period with no lines says so and never claims balanced books', () => {
    render(
      <TrialBalancePanel
        trialBalance={{
          legal_entity_id: BRAND_D,
          from: '2026-01-01',
          to: '2026-01-31',
          rows: [],
          totals: [],
        }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'No ledger lines in 2026-01-01 – 2026-01-31',
    );
    expect(screen.queryByText('Balanced')).toBeNull();
  });
});

const journal: JournalLinePage = {
  page: 1,
  limit: 20,
  total: 41,
  items: [
    {
      id: '00000000-0000-4000-8000-00000000a001',
      legal_entity_id: BRAND_D,
      store_id: STORE_D,
      journal: 'sales',
      entry_date: '2026-11-13',
      account_code: '1200',
      account_name: 'Accounts receivable — trade',
      debit_minor: 1980,
      credit_minor: 0,
      currency: 'JPY',
      source_event_id: '00000000-0000-4000-8000-00000000e001',
      source_topic: 'order.placed',
      reference_type: 'order',
      reference_id: ORDER,
      posted_to_erp_at: null,
      erp_reference: null,
      created_at: '2026-11-13T08:30:00Z',
    },
    {
      id: '00000000-0000-4000-8000-00000000a002',
      legal_entity_id: BRAND_D,
      store_id: STORE_D,
      journal: 'bank',
      entry_date: '2026-11-14',
      account_code: '1000',
      account_name: 'Bank',
      debit_minor: 0,
      credit_minor: 1980,
      currency: 'JPY',
      source_event_id: '00000000-0000-4000-8000-00000000e002',
      source_topic: 'payout.posted',
      reference_type: 'payout',
      reference_id: '00000000-0000-4000-8000-00000000d001',
      posted_to_erp_at: '2026-11-14T10:00:00Z',
      erp_reference: 'MISC/2026/0042',
      created_at: '2026-11-14T09:00:00Z',
    },
  ],
};

describe('JournalPanel', () => {
  const view = readFinanceView({
    entity: BRAND_D,
    tab: 'journal',
    journal: 'sales',
    currency: 'JPY',
  });

  it('whole yen, an order reference links to the store order, ERP state per line', () => {
    render(<JournalPanel page={journal} view={view} />);
    const table = screen.getByRole('table', { name: 'Journal lines' });
    expect(within(table).getAllByText(/^(JP)?¥1,980$/)).toHaveLength(2);
    expect(within(table).getByRole('link', { name: /order 848ec7e3/ })).toHaveAttribute(
      'href',
      `/${STORE_D}/orders/${ORDER}`,
    );
    expect(within(table).queryByRole('link', { name: /payout/ })).toBeNull();
    expect(within(table).getByText('not yet')).toBeInTheDocument();
    expect(within(table).getByText('MISC/2026/0042')).toBeInTheDocument();
  });

  it('pages keep the filters', () => {
    render(<JournalPanel page={journal} view={view} />);
    expect(screen.getByText(/Page 1 of 3 · 41 lines/)).toBeInTheDocument();
    const next = screen.getByRole('link', { name: 'Next' }).getAttribute('href') ?? '';
    const params = new URL(next, 'http://x').searchParams;
    expect(Object.fromEntries(params)).toEqual({
      entity: BRAND_D,
      tab: 'journal',
      currency: 'JPY',
      journal: 'sales',
      page: '2',
    });
    expect(screen.queryByRole('link', { name: 'Previous' })).toBeNull();
  });

  it('no lines is said, not an empty table', () => {
    render(<JournalPanel page={{ page: 1, limit: 20, total: 0, items: [] }} view={view} />);
    expect(screen.getByRole('status')).toHaveTextContent('No journal lines match these filters.');
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('EntityList', () => {
  it('lists books with their currencies and marks the selected entity', () => {
    render(
      <EntityList
        entities={[
          {
            legal_entity_id: BRAND_D,
            code: 'le-brand-d',
            name: 'Brand D K.K.',
            reporting_currency: 'JPY',
            currencies: ['JPY'],
            entries: 4,
            unposted_entries: 4,
            first_entry_date: '2026-11-13',
            last_entry_date: '2026-11-13',
            odoo_company_id: null,
          },
        ]}
        selected={BRAND_D}
        tab="trial-balance"
      />,
    );
    const row = screen.getByRole('row', { name: /Brand D K\.K\./ });
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(row).toHaveTextContent('JPY');
    expect(row).toHaveTextContent('not mapped');
  });

  it('no books yet is said', () => {
    render(<EntityList entities={[]} selected={null} tab="trial-balance" />);
    expect(screen.getByRole('status')).toHaveTextContent('No legal entity has books yet');
  });
});
