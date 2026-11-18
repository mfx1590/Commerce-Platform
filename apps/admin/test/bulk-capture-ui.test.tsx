/**
 * "Capture…" in the orders bulk bar (#870 wave 1 item 2, the money PR): ticked rows only and at
 * most 100, a preview with the count and per-currency totals before anything moves, the count
 * typed, exactly the previewed amounts sent, every row reported, a lost run never retried.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { describeTotals } from '@/lib/orders/bulk-capture';
import type { Selection } from '@/lib/table/selection';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/s/orders' }));
const actions = vi.hoisted(() => ({
  previewBulkCaptureAction: vi.fn(),
  bulkCaptureAction: vi.fn(),
}));
vi.mock('@/app/actions/bulk-capture', () => actions);

const { BulkCapture } = await import('@/app/(store)/[storeId]/orders/bulk-capture');

const STORE = '00000000-0000-4000-8000-000000000031';
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ticked = (...ns: number[]): Selection => ({ mode: 'rows', ids: new Set(ns.map(id)) });
const preview = {
  capturable: 2,
  totals: { JPY: 1200, EUR: 4550 },
  rows: [
    {
      id: id(1),
      label: '#1001',
      capturable: true,
      amountMinor: 1200,
      currency: 'JPY',
      message: 'JP¥1,200',
    },
    {
      id: id(2),
      label: '#1002',
      capturable: true,
      amountMinor: 4550,
      currency: 'EUR',
      partial: true,
      message: '€45.50 of €50.00 authorised (the order total is lower now).',
    },
    { id: id(3), label: '#1003', capturable: false, message: 'Already captured.' },
  ],
};

function setup(selection: Selection) {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(<BulkCapture storeId={STORE} locale="en-GB" selection={selection} onClose={onClose} />);
  return { user, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  actions.previewBulkCaptureAction.mockResolvedValue({ status: 'success', data: preview });
  actions.bulkCaptureAction.mockResolvedValue({
    status: 'success',
    data: {
      results: [
        { id: id(1), label: '#1001', outcome: 'done', message: 'Captured JP¥1,200.' },
        {
          id: id(2),
          label: '#1002',
          outcome: 'unknown',
          message: 'Outcome unknown (reset): check this row before running it again.',
        },
      ],
      counts: { done: 1, skipped: 0, failed: 0, unknown: 1, refused: 0 },
    },
  });
});

describe('BulkCapture', () => {
  it('"all matching" is never offered: ticked orders only', () => {
    setup({ mode: 'all-matching', total: 40, excluded: new Set() });
    expect(screen.queryByRole('button', { name: 'Capture…' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/ticked orders only \(at most 100\), not on all matching/),
    ).toBeInTheDocument();
  });

  it('more than 100 ticked: not offered, said why', () => {
    setup({ mode: 'rows', ids: new Set(Array.from({ length: 101 }, (_, i) => id(i + 1))) });
    expect(screen.queryByRole('button', { name: 'Capture…' })).not.toBeInTheDocument();
    expect(screen.getByText(/at most 100 ticked orders \(101 are ticked\)/)).toBeInTheDocument();
  });

  it('previews first: count, per-currency totals, each order, and what will not be captured', async () => {
    const { user } = setup(ticked(1, 2, 3));
    await user.click(screen.getByRole('button', { name: 'Capture…' }));
    expect(actions.previewBulkCaptureAction).toHaveBeenCalledWith(
      STORE,
      [id(1), id(2), id(3)],
      'en-GB',
    );
    expect(actions.bulkCaptureAction).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog', { name: 'Capture 2 orders?' });
    expect(within(dialog).getByLabelText('Total to capture')).toHaveTextContent(
      'Total to capture: €45.50 · JP¥1,200 — exactly 2 ticked orders, each at most its authorisation.',
    );
    expect(dialog).toHaveTextContent('1 order is not captured');
    const list = within(dialog).getByLabelText('What each order captures');
    expect(list).toHaveTextContent('#1003Already captured.');
    expect(list).toHaveTextContent('#1002€45.50 of €50.00 authorised');
  });

  it('the count typed, then exactly the previewed amounts are sent; every row reported', async () => {
    const { user } = setup(ticked(1, 2, 3));
    await user.click(screen.getByRole('button', { name: 'Capture…' }));
    const yes = await screen.findByRole('button', { name: 'Yes, capture €45.50 · JP¥1,200' });
    expect(yes).toBeDisabled();
    await user.type(screen.getByLabelText('Type 2 to confirm'), '3');
    expect(yes).toBeDisabled();
    await user.clear(screen.getByLabelText('Type 2 to confirm'));
    await user.type(screen.getByLabelText('Type 2 to confirm'), '2');
    await user.click(yes);
    expect(actions.bulkCaptureAction).toHaveBeenCalledWith(
      STORE,
      [
        { id: id(1), amountMinor: 1200, currency: 'JPY' },
        { id: id(2), amountMinor: 4550, currency: 'EUR' },
      ],
      'en-GB',
    );
    const results = await screen.findByRole('region', { name: 'Capture results' });
    expect(within(results).getByRole('status')).toHaveTextContent(
      'Capture: 1 done · 1 outcome unknown',
    );
    expect(within(results).getAllByRole('listitem')[0]).toHaveTextContent('Outcome unknown#1002');
    expect(
      within(results).getByRole('button', { name: 'Download results (CSV)' }),
    ).toBeInTheDocument();
  });

  it('nothing capturable: no confirmation, no capture button', async () => {
    actions.previewBulkCaptureAction.mockResolvedValue({
      status: 'success',
      data: { capturable: 0, totals: {}, rows: [preview.rows[2]] },
    });
    const { user } = setup(ticked(3));
    await user.click(screen.getByRole('button', { name: 'Capture…' }));
    expect(
      await screen.findByText('None of the ticked orders can be captured.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Yes, capture/ })).not.toBeInTheDocument();
  });

  it('a capture run that never comes back is "outcome unknown", sent once, never retried', async () => {
    actions.bulkCaptureAction.mockRejectedValue(new TypeError('Failed to fetch'));
    const { user, onClose } = setup(ticked(1, 2));
    await user.click(screen.getByRole('button', { name: 'Capture…' }));
    await user.type(await screen.findByLabelText('Type 2 to confirm'), '2');
    await user.click(screen.getByRole('button', { name: /^Yes, capture/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Capture: outcome unknown — the request did not come back.');
    expect(actions.bulkCaptureAction).toHaveBeenCalledTimes(1);
    expect(router.refresh).toHaveBeenCalled();
    await user.click(within(alert).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('a refused preview is shown; nothing captured', async () => {
    actions.previewBulkCaptureAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: 'requires store_admin on store',
    });
    const { user } = setup(ticked(1));
    await user.click(screen.getByRole('button', { name: 'Capture…' }));
    expect(await screen.findByText('requires store_admin on store')).toBeInTheDocument();
    expect(actions.bulkCaptureAction).not.toHaveBeenCalled();
  });

  it('a ja-JP store sees yen as it writes it', () => {
    expect(describeTotals({ JPY: 120000 }, 'ja-JP')).toBe('￥120,000');
  });
});
