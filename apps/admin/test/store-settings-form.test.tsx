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
    // Only the touched field is sent, and the confirmation names it with its value (#968 review).
    expect(save).toHaveBeenCalledWith(STORE, 'tax', { 'tax.prices_include_tax': true }, LOADED, [
      { path: 'tax.prices_include_tax', to: true },
    ]);
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
    // Unchecking everything CLEARS the path rather than storing `[]`: the core then runs both
    // checks, which is the safe reading and what the hint now says. Switching fraud checking off
    // is deliberately not reachable from a checkbox.
    expect(within(dialog).getByText('not set')).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: /Confirm the fraud change/ })).toBeNull();
  });

  it('an ordinary change is saved without interrupting anyone', async () => {
    const user = userEvent.setup();
    render(form('tax'));

    // `tax.provider` is not in the confirm set; `shipping_taxable` joined it in the #968 review.
    await user.selectOptions(screen.getByLabelText('Calculated by'), 'stripe');
    await user.click(screen.getByRole('button', { name: /Save tax/ }));

    expect(screen.queryByRole('group', { name: /Confirm/ })).toBeNull();
    expect(save).toHaveBeenCalledWith(STORE, 'tax', { 'tax.provider': 'stripe' }, LOADED, []);
  });

  it('sends ONLY the touched field, never the untouched ones (#968 review)', async () => {
    // The defect this fixes: the card submitted every field, so an absent `fraud.providers` went
    // out as `[]` — switching fraud checking off on a store nobody had touched.
    const user = userEvent.setup();
    render(form('fraud'));

    await user.selectOptions(
      screen.getByLabelText(/Billing and shipping countries differ/),
      'allow',
    );
    await user.click(screen.getByRole('button', { name: /Save fraud/ }));
    await user.click(screen.getByRole('button', { name: 'Yes, save it' }));

    expect(save).toHaveBeenCalledWith(
      STORE,
      'fraud',
      // Exactly one key: `providers`, `velocity.*` and `radar_highest` are not in the request.
      { 'fraud.country_mismatch': 'allow' },
      LOADED,
      [{ path: 'fraud.country_mismatch', to: 'allow' }],
    );
  });

  it('an edit after the dialog opens withdraws the confirmation', async () => {
    const user = userEvent.setup();
    render(form('tax'));

    await user.selectOptions(screen.getByLabelText('Prices include tax'), 'true');
    await user.click(screen.getByRole('button', { name: /Save tax/ }));
    expect(screen.getByRole('group', { name: /Confirm the tax change/ })).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('Calculated by'), 'stripe');
    expect(screen.queryByRole('group', { name: /Confirm the tax change/ })).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('shows the core default for a field nobody has set', () => {
    render(form('fraud'));
    // `fraud.radar_highest` is absent from the fixture. It must not read as a value: an absent
    // path means the core's own default, which for this one is to REFUSE the payment.
    const select = screen.getByLabelText(/Radar/);
    expect(select).toHaveValue('');
    expect(within(select).getByRole('option', { selected: true })).toHaveTextContent(
      /not set \(default: block/,
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
      [{ path: 'support_refund_limit_minor', to: 60_000 }],
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
      [{ path: 'support_refund_limit_minor', to: 1980 }],
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

describe('lists and the country map (#870 item 7 PR B)', () => {
  const shipping = (over: Record<string, unknown> = {}) => (
    <SettingsCardForm
      storeId={STORE}
      cardId="shipping"
      current={cardValues('shipping', {
        shipping: {
          provider: 'easypost',
          services: ['ups_ground', 'usps_priority'],
          carrier_account_ids: ['ca_1'],
          ...over,
        },
      })}
      updatedAt={LOADED}
      currency="EUR"
      locale="en-GB"
    />
  );

  it('shows a list one per line and sends it as an array', async () => {
    const user = userEvent.setup();
    render(shipping());

    const services = screen.getByLabelText(/Services offered/);
    expect(services).toHaveValue('ups_ground\nusps_priority');
    await user.clear(services);
    await user.type(services, 'ups_ground');
    await user.click(screen.getByRole('button', { name: /Save shipping/ }));

    // Exactly one key: `provider` and `carrier_account_ids` were not touched, so they are not sent.
    expect(save).toHaveBeenCalledWith(
      STORE,
      'shipping',
      { 'shipping.services': ['ups_ground'] },
      LOADED,
      [],
    );
  });

  it('asks before swapping carrier accounts, because that changes who is billed', async () => {
    const user = userEvent.setup();
    render(shipping());

    const accounts = screen.getByLabelText(/Carrier accounts/);
    await user.clear(accounts);
    await user.type(accounts, 'ca_2');
    await user.click(screen.getByRole('button', { name: /Save shipping/ }));

    const dialog = screen.getByRole('group', { name: /Confirm the shipping defaults change/ });
    expect(within(dialog).getByText('ca_1')).toBeTruthy();
    expect(within(dialog).getByText('ca_2')).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it('reads the country map as lines and sends it as an object', async () => {
    const user = userEvent.setup();
    render(
      <SettingsCardForm
        storeId={STORE}
        cardId="fulfillment"
        current={cardValues('fulfillment', {
          fulfillment: { routing: { countries: { NL: 'wh-eu' } } },
        })}
        updatedAt={LOADED}
        currency="EUR"
        locale="en-GB"
      />,
    );

    const map = screen.getByLabelText(/Per-country overrides/);
    expect(map).toHaveValue('NL = wh-eu');
    await user.clear(map);
    await user.type(map, 'NL = wh-eu\njp: wh-jp');
    await user.click(screen.getByRole('button', { name: /Save fulfilment/ }));

    expect(save).toHaveBeenCalledWith(
      STORE,
      'fulfillment',
      // A lower-case country is upper-cased, and a colon is accepted because somebody will type one.
      { 'fulfillment.routing.countries': { NL: 'wh-eu', JP: 'wh-jp' } },
      LOADED,
      [],
    );
  });

  it('an emptied list clears the path instead of sending an empty array', async () => {
    // `[]` is a VALUE to the core: empty `services` would be read as "narrow to nothing" and empty
    // `carrier_account_ids` as "send no accounts". Absent is what means "the carrier's default".
    const user = userEvent.setup();
    render(shipping());

    await user.clear(screen.getByLabelText(/Services offered/));
    await user.click(screen.getByRole('button', { name: /Save shipping/ }));

    expect(save).toHaveBeenCalledWith(
      STORE,
      'shipping',
      { 'shipping.services': undefined },
      LOADED,
      [],
    );
  });

  it('shows the core default for a list nobody has set, and it is not "none"', () => {
    render(
      <SettingsCardForm
        storeId={STORE}
        cardId="shipping"
        current={cardValues('shipping', {})}
        updatedAt={LOADED}
        currency="EUR"
        locale="en-GB"
      />,
    );
    // An absent `services` offers EVERYTHING the carrier quotes. Reading it as "none offered" is
    // backwards, which is why the default is spelled out rather than left as an empty box.
    expect(screen.getByText(/not set .default: no narrowing/)).toBeTruthy();
    const format = screen.getByLabelText('Label format');
    expect(format).toHaveValue('');
    // An enum, not a free-text box: the core accepts only pdf/png/zpl and silently ignores the
    // rest, so a typed `PDF417` would have looked accepted.
    expect(
      within(format)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['not set (default: pdf)', 'pdf', 'png', 'zpl']);
  });

  it('says which line is wrong rather than dropping it', async () => {
    const user = userEvent.setup();
    render(
      <SettingsCardForm
        storeId={STORE}
        cardId="fulfillment"
        current={cardValues('fulfillment', {})}
        updatedAt={LOADED}
        currency="EUR"
        locale="en-GB"
      />,
    );

    await user.type(screen.getByLabelText(/Per-country overrides/), 'Netherlands = wh-eu');
    await user.click(screen.getByRole('button', { name: /Save fulfilment/ }));

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText(/"Netherlands = wh-eu" is not/)).toBeTruthy();
  });
});

describe('clearing a value', () => {
  it('an emptied limit means "no ceiling", and the diff says so before it is saved', async () => {
    const user = userEvent.setup();
    render(form('refunds'));
    await user.clear(screen.getByLabelText(/Support refund limit/));
    await user.click(screen.getByRole('button', { name: /Save refunds/ }));

    const dialog = screen.getByRole('group', { name: /Confirm the refunds change/ });
    expect(within(dialog).getByText('€50.00')).toBeTruthy();
    expect(within(dialog).getByText('not set')).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Yes, save it' }));
    expect(save).toHaveBeenCalledWith(
      STORE,
      'refunds',
      { support_refund_limit_minor: undefined },
      LOADED,
      [{ path: 'support_refund_limit_minor', to: undefined }],
    );
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
