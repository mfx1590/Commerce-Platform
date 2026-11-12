/**
 * The Payment form (#825): it sends the toggle and the `updated_at` it rendered; after a save it
 * carries the store's new `updated_at`, so a second save from the same page is not refused as stale.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentSettingsForm } from '@/app/(store)/[storeId]/settings/payment-form';

vi.mock('server-only', () => ({}));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/',
}));
const action = vi.hoisted(() => vi.fn());
vi.mock('@/app/actions/store-payment', () => ({ updatePaymentSettingsAction: action }));

const STORE = '00000000-0000-4000-8000-000000000031';

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the once-queue too: a leftover answer must never leak into the next test.
  action.mockReset();
});

describe('PaymentSettingsForm', () => {
  it('turns invoice on with the rendered updated_at, then uses the new one for the next save', async () => {
    action
      .mockResolvedValueOnce({
        status: 'success',
        data: { invoice_allowed: true, updated_at: 'T2' },
      })
      .mockResolvedValueOnce({
        status: 'success',
        data: { invoice_allowed: false, updated_at: 'T3' },
      });
    const user = userEvent.setup();
    render(<PaymentSettingsForm storeId={STORE} invoiceAllowed={false} updatedAt="T1" />);

    const save = screen.getByRole('button', { name: 'Save payment settings' });
    expect(save).toBeDisabled(); // nothing changed yet
    await user.click(screen.getByRole('checkbox', { name: /Pay on invoice/ }));
    await user.click(save);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action).toHaveBeenLastCalledWith(STORE, {
      invoice_allowed: true,
      loaded_updated_at: 'T1',
    });
    expect(await screen.findByRole('status')).toHaveTextContent('customers can pay on invoice');

    await user.click(screen.getByRole('checkbox', { name: /Pay on invoice/ }));
    await user.click(save);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(action).toHaveBeenLastCalledWith(STORE, {
      invoice_allowed: false,
      loaded_updated_at: 'T2',
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('a refusal (stale page, 422) is said under the form', async () => {
    action.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError:
        'The store was changed since this page was opened. Reload the page and try again — nothing was saved.',
    });
    const user = userEvent.setup();
    render(<PaymentSettingsForm storeId={STORE} invoiceAllowed={false} updatedAt="T1" />);
    await user.click(screen.getByRole('checkbox', { name: /Pay on invoice/ }));
    await user.click(screen.getByRole('button', { name: 'Save payment settings' }));
    expect(await screen.findByText(/changed since this page was opened/)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
