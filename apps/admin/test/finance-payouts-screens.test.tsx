/**
 * HQ › Finance part 2 (#851): payouts and their reconciliation in the payout's own currency (JPY
 * whole yen), each line's verdict and difference, the ERP mapping gaps, and parked events that
 * point at the order whose `order.placed` is missing.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ErpStatusPanel,
  ParkedEventsPanel,
  PayoutDetailPanel,
  PayoutsPanel,
} from '@/app/(hq)/finance/payout-panels';
import type { Payout, PayoutDetail } from '@/lib/api/accounting-client';
import { readFinanceView } from '@/lib/finance';

const BRAND_D = '00000000-0000-4000-8000-0000000000d1';
const STORE_D = '9f3c3c2a-42a5-4903-bb1d-fd47e4f6324e';
const PAYOUT = '00000000-0000-4000-8000-00000000d001';

const payout: Payout = {
  id: PAYOUT,
  legal_entity_id: BRAND_D,
  provider: 'stripe',
  provider_payout_id: 'po_fixture_le_brand_d_01',
  currency: 'JPY',
  amount_minor: 4460,
  arrival_date: '2026-11-15',
  status: 'discrepant',
  line_count: 3,
  matched_count: 1,
  discrepancy_count: 2,
  posted_at: null,
  imported_at: '2026-11-15T09:00:00Z',
  reconciled_at: null,
};

describe('PayoutsPanel', () => {
  const view = readFinanceView({ entity: BRAND_D, tab: 'payouts', status: 'discrepant' });

  it('JPY payout in whole yen, status and reconciliation counts, a link to the payout', () => {
    render(<PayoutsPanel page={{ page: 1, limit: 20, total: 1, items: [payout] }} view={view} />);
    const row = screen.getByRole('row', { name: /po_fixture_le_brand_d_01/ });
    expect(within(row).getByText(/^(JP)?¥4,460$/)).toBeInTheDocument();
    expect(row).not.toHaveTextContent('¥44.60');
    expect(within(row).getByText('discrepant')).toBeInTheDocument();
    expect(within(row).getByText('1 / 3')).toBeInTheDocument();
    expect(within(row).getByText('not yet')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'po_fixture_le_brand_d_01' })).toHaveAttribute(
      'href',
      `/finance/payouts/${PAYOUT}?entity=${BRAND_D}`,
    );
  });

  it('pages keep the payout filters', () => {
    render(<PayoutsPanel page={{ page: 1, limit: 1, total: 2, items: [payout] }} view={view} />);
    const next = new URL(
      screen.getByRole('link', { name: 'Next' }).getAttribute('href') ?? '',
      'http://x',
    );
    expect(Object.fromEntries(next.searchParams)).toEqual({
      entity: BRAND_D,
      tab: 'payouts',
      status: 'discrepant',
      page: '2',
    });
  });

  it('no payouts is said', () => {
    render(<PayoutsPanel page={{ page: 1, limit: 20, total: 0, items: [] }} view={view} />);
    expect(screen.getByRole('status')).toHaveTextContent('No payouts match these filters.');
  });
});

describe('PayoutDetailPanel', () => {
  const detail: PayoutDetail = {
    ...payout,
    lines: {
      page: 1,
      limit: 20,
      total: 3,
      items: [
        {
          id: '00000000-0000-4000-8000-00000000f001',
          provider_txn_id: 'txn_fixture_match',
          kind: 'charge',
          provider_reference: 'pi_fixture_ok',
          amount_minor: 1980,
          fee_minor: 70,
          net_minor: 1910,
          currency: 'JPY',
          available_on: '2026-11-14',
          matched_reference_type: 'payment',
          matched_reference_id: '00000000-0000-4000-8000-00000000b001',
          match_status: 'matched',
          difference_minor: 0,
        },
        {
          id: '00000000-0000-4000-8000-00000000f002',
          provider_txn_id: 'txn_fixture_fee',
          kind: 'charge',
          provider_reference: 'pi_fixture_fee',
          amount_minor: 2480,
          fee_minor: 95,
          net_minor: 2385,
          currency: 'JPY',
          available_on: '2026-11-14',
          matched_reference_type: 'payment',
          matched_reference_id: '00000000-0000-4000-8000-00000000b002',
          match_status: 'fee_mismatch',
          difference_minor: 8,
        },
        {
          id: '00000000-0000-4000-8000-00000000f003',
          provider_txn_id: 'txn_fixture_unknown',
          kind: 'charge',
          provider_reference: null,
          amount_minor: 500,
          fee_minor: 0,
          net_minor: 500,
          currency: 'JPY',
          available_on: null,
          matched_reference_type: null,
          matched_reference_id: null,
          match_status: 'unmatched',
          difference_minor: 500,
        },
      ],
    },
  };

  it('each line: amount, fee, net in yen; the verdict in words; the difference only when not zero', () => {
    render(<PayoutDetailPanel payout={detail} entity={BRAND_D} />);
    expect(screen.getByText(/1 of 3 lines matched, 2 not/)).toBeInTheDocument();
    const lines = screen.getByRole('table', { name: 'Payout lines' });
    const fee = within(lines).getByRole('row', { name: /txn_fixture_fee/ });
    expect(within(fee).getByText('Fee differs')).toBeInTheDocument();
    expect(within(fee).getByText(/^(JP)?¥95$/)).toBeInTheDocument();
    expect(within(fee).getByText(/^(JP)?¥8$/)).toBeInTheDocument();
    const unknown = within(lines).getByRole('row', { name: /txn_fixture_unknown/ });
    expect(within(unknown).getByText('No ledger entry')).toBeInTheDocument();
    expect(within(unknown).getByText('—')).toBeInTheDocument();
    const ok = within(lines).getByRole('row', { name: /txn_fixture_match/ });
    expect(within(ok).getByText('Matched')).toBeInTheDocument();
    expect(within(ok).getByText(/payment/)).toHaveTextContent('payment 00000000');
  });
});

describe('the ops view', () => {
  it('ERP: unmapped account codes are an alert; posting progress in counts', () => {
    render(
      <ErpStatusPanel
        status={{
          legal_entity_id: BRAND_D,
          odoo_company_id: null,
          chart: { accounts: 12, mapped: 10, unmapped_codes: ['4010', '6100'] },
          entries: 4,
          posted_entries: 0,
          unposted_entries: 4,
          oldest_unposted_entry_date: '2026-11-13',
          last_posted_at: null,
        }}
      />,
    );
    const erp = screen.getByRole('region', { name: 'ERP sync' });
    expect(erp).toHaveTextContent('not mapped — nothing can be posted');
    expect(erp).toHaveTextContent('10 of 12 accounts mapped');
    expect(within(erp).getByRole('alert')).toHaveTextContent('4010, 6100');
    expect(erp).toHaveTextContent('0 of 4 posted, 4 waiting');
    expect(erp).toHaveTextContent('never');
  });

  it('parked events link to the order whose order.placed is missing', () => {
    const order = '848ec7e3-0000-4000-8000-000000000777';
    render(
      <ParkedEventsPanel
        page={{
          page: 1,
          limit: 20,
          total: 1,
          items: [
            {
              outbox_id: '00000000-0000-4000-8000-00000000e777',
              store_id: STORE_D,
              topic: 'shipment.shipped',
              version: 1,
              order_id: order,
              occurred_at: '2026-11-13T08:00:00Z',
              parked_at: '2026-11-13T08:00:02Z',
            },
          ],
        }}
        view={readFinanceView({ entity: BRAND_D, tab: 'ops' })}
      />,
    );
    expect(screen.getByRole('link', { name: '848ec7e3' })).toHaveAttribute(
      'href',
      `/${STORE_D}/orders/${order}`,
    );
    expect(screen.getByText('shipment.shipped v1')).toBeInTheDocument();
  });

  it('nothing parked is said', () => {
    render(
      <ParkedEventsPanel
        page={{ page: 1, limit: 20, total: 0, items: [] }}
        view={readFinanceView({ entity: BRAND_D, tab: 'ops' })}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Nothing is parked');
  });
});
