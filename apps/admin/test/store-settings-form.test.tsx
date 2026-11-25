/**
 * The settings card form (#870 item 7): the diff before a consequential save, and money.
 *
 * The confirm step is a courtesy — `saveStoreSettingsAction` refuses an unconfirmed change to a
 * `CONFIRM_PATHS` path anyway (`test/store-settings-action.test.ts`). What this file holds is that
 * the reader is *shown* what would change before being asked, that an ordinary change is not
 * interrupted, and that an amount is read and sent in the store's own currency.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsCardForm, cardValues } from '@/app/(store)/[storeId]/settings/settings-card-form';
import { SEED } from './fixtures/principals';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/settings',
}));

const save = vi.hoisted(() => vi.fn());
vi.mock('@/app/actions/store-settings', () => ({ saveStoreSettingsAction: save }));

const STORE = SEED.stores.brandA;
const LOADED = '2026-11-25T10:00:00.000Z';

const SETTINGS = {
  tax: { provider: 'table', prices_include_tax: false, shipping_taxable: true },
  fraud: { providers: ['rules'], velocity: { max_orders: 5, window_minutes: 60 } },
  support_refund_limit_minor: 5000,
};

const form = (cardId: 'tax' | 'fraud' | 'refunds', currency = 'EUR') => (
  <SettingsCardForm
    storeId={STORE}
    cardId={cardId}
    current={cardValues(cardId, SETTINGS)}
    updatedAt={LOADED}
    currency={currency}
    locale="en-GB"
  />
);

beforeEach(() => {
  vi.clearAllMocks();
  save.mockResolvedValue({ status: 'success', data: { updated_at: '2026-11-25T11:00:00.000Z' } });
});

describe('a consequential change is shown before it is asked about', () => {
  it('turning tax-inclusive prices on shows the diff and sends nothing yet', async () => {
    const user = userEvent.setup();
    render(form('tax'));

    await user.selectOptions(screen.getByLabelText('Prices include tax'), 'true');
    await user.click(screen.getByRole('button', { name: /Save tax/ }));

    const dialog = screen.getByRole('group', { name: /Confirm the tax change/ });
    expect(within(dialog).getByText(/Prices include tax/)).toBeTruthy();
    expect(within(dialog).getByText('off')).toBeTruthy();
    expect(within(dialog).getByText('on')).toBeTruthy();
    expect(save).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Yes, save it' }));
    expect(save).toHaveBeenCalledWith(
      STORE,
      'tax',
      expect.objectContaining({ 'tax.prices_include_tax': true }),
      LOADED,
      true,
    );
  });

  it('cancelling sends nothing and leaves the draft alone', async () => {
    const user = userEvent.setup();
    render(form('fraud'));

    // Dropping a fraud check is in the confirm set: it lets more orders through unchecked.
    await user.click(
      within(screen.getByRole('group', { name: 'Checks to run' })).getByLabelText('rules'),
    );
    await user.click(screen.getByRole('button', { name: /Save fraud/ }));
    const dialog = screen.getByRole('group', { name: /Confirm the fraud change/ });
    expect(within(dialog).getByText('rules')).toBeTruthy();
    expect(within(dialog).getByText('none')).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: /Confirm the fraud change/ })).toBeNull();
  });

  it('an ordinary change is saved without interrupting anyone', async () => {
    const user = userEvent.setup();
    render(form('tax'));

    await user.selectOptions(screen.getByLabelText('Shipping is taxable'), 'false');
    await user.click(screen.getByRole('button', { name: /Save tax/ }));

    expect(screen.queryByRole('group', { name: /Confirm/ })).toBeNull();
    expect(save).toHaveBeenCalledWith(
      STORE,
      'tax',
      expect.objectContaining({ 'tax.shipping_taxable': false }),
      LOADED,
      false,
    );
  });

  it('saving with nothing changed asks nothing and sends nothing', async () => {
    const user = userEvent.setup();
    render(form('tax'));
    await user.click(screen.getByRole('button', { name: /Save tax/ }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
  });
});

describe('money is the store’s own', () => {
  it('reads an amount and sends minor units', async () => {
    const user = userEvent.setup();
    render(form('refunds'));

    const input = screen.getByLabelText(/Support refund limit/);
    expect(input).toHaveValue('50.00');
    await user.clear(input);
    await user.type(input, '600');
    await user.click(screen.getByRole('button', { name: /Save refunds/ }));

    const dialog = screen.getByRole('group', { name: /Confirm the refunds change/ });
    // The diff speaks in the store's currency, not in minor units.
    expect(within(dialog).getByText('€50.00')).toBeTruthy();
    expect(within(dialog).getByText('€600.00')).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Yes, save it' }));
    expect(save).toHaveBeenCalledWith(
      STORE,
      'refunds',
      { support_refund_limit_minor: 60_000 },
      LOADED,
      true,
    );
  });

  it('a zero-decimal currency never shows or sends a fractional amount', async () => {
    const user = userEvent.setup();
    render(form('refunds', 'JPY'));

    const input = screen.getByLabelText(/Support refund limit/);
    // 5000 minor units of JPY is ¥5,000 — not 50.00.
    expect(input).toHaveValue('5000');
    await user.clear(input);
    await user.type(input, '1980');
    await user.click(screen.getByRole('button', { name: /Save refunds/ }));
    await user.click(screen.getByRole('button', { name: 'Yes, save it' }));

    expect(save).toHaveBeenCalledWith(
      STORE,
      'refunds',
      { support_refund_limit_minor: 1980 },
      LOADED,
      true,
    );
  });

  it('refuses an amount that is not one, before anything is sent', async () => {
    const user = userEvent.setup();
    render(form('refunds'));
    const input = screen.getByLabelText(/Support refund limit/);
    await user.clear(input);
    await user.type(input, 'lots');
    await user.click(screen.getByRole('button', { name: /Save refunds/ }));

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText(/not an amount in this currency/)).toBeTruthy();
  });
});

describe('what the action says comes back to the field', () => {
  it('puts a field error on its own input', async () => {
    save.mockResolvedValue({
      status: 'error',
      fieldErrors: { 'fraud.velocity.max_orders': 'A whole number, 1 or more.' },
      formError: 'Some fields are not valid.',
    });
    const user = userEvent.setup();
    render(form('fraud'));

    await user.selectOptions(
      screen.getByLabelText(/Billing and shipping countries differ/),
      'allow',
    );
    await user.click(screen.getByRole('button', { name: /Save fraud/ }));
    await user.click(screen.getByRole('button', { name: 'Yes, save it' }));

    expect(screen.getByText('A whole number, 1 or more.')).toBeTruthy();
  });
});
