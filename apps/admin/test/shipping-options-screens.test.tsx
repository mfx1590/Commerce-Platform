/**
 * Shipping options on screen (#809): Store settings lists, adds (price in the chosen currency's own
 * units: JPY whole yen), edits and deactivates options, with the live store's 409 said in words; the
 * readiness panel turns activateStore's 409 `shipping_options` into one "Create a shipping option for
 * XX" form per uncovered country, offered only with store_admin (tax's too), else the relation needed.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivatePanel } from '@/app/(hq)/onboarding/[storeId]/activate-panel';
import {
  CreateShippingOptionForm,
  ShippingOptionsTable,
} from '@/components/shipping-options/shipping-option-forms';

vi.mock('server-only', () => ({}));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/',
}));
const storeActions = vi.hoisted(() => ({ activateStoreAction: vi.fn() }));
vi.mock('@/app/actions/stores', () => storeActions);
vi.mock('@/app/actions/tax-rates', () => ({
  createTaxRateAction: vi.fn(),
  updateTaxRateAction: vi.fn(),
  deleteTaxRateAction: vi.fn(),
}));
const shipActions = vi.hoisted(() => ({
  createShippingOptionAction: vi.fn(),
  createCountryShippingOptionAction: vi.fn(),
  updateShippingOptionAction: vi.fn(),
}));
vi.mock('@/app/actions/shipping-options', () => shipActions);

const STORE = '00000000-0000-4000-8000-000000000034';
const option = (over: Record<string, unknown> = {}) => ({
  id: '76000000-0000-4000-8000-000000000001',
  code: 'standard',
  name: 'Standard',
  carrier: 'manual',
  service: null,
  price: { amount_minor: 1980, currency: 'JPY' },
  countries: ['JP'],
  sales_channel_id: null,
  rules: {},
  is_active: true,
  ...over,
});
const blocked = (missing: string[], shipping?: string[], tax?: string[]) => ({
  status: 'error' as const,
  fieldErrors: {},
  formError: 'Cannot activate.',
  missing,
  ...(shipping === undefined ? {} : { missingShippingCountries: shipping }),
  ...(tax === undefined ? {} : { missingTaxCountries: tax }),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Store settings › Shipping options', () => {
  it('lists each option with its price in its own currency and its countries', () => {
    render(
      <ShippingOptionsTable
        storeId={STORE}
        options={[
          option(),
          option({
            id: 'x',
            code: 'eu',
            price: { amount_minor: 495, currency: 'EUR' },
            countries: ['NL', 'DE'],
            is_active: false,
          }),
        ]}
        canManage
        locale="en-GB"
      />,
    );
    const jp = screen.getByRole('row', { name: 'Shipping option Standard (standard)' });
    expect(jp).toHaveTextContent('¥1,980');
    expect(jp).toHaveTextContent('JP');
    expect(jp).toHaveTextContent('active');
    const eu = screen.getByRole('row', { name: 'Shipping option Standard (eu)' });
    expect(eu).toHaveTextContent('€4.95');
    expect(eu).toHaveTextContent('NL, DE');
    expect(
      within(eu).getByRole('button', { name: 'Reactivate Standard (eu)' }),
    ).toBeInTheDocument();
  });

  it('reads only, below store_admin: no Edit or Deactivate', () => {
    render(
      <ShippingOptionsTable
        storeId={STORE}
        options={[option()]}
        canManage={false}
        locale="en-GB"
      />,
    );
    expect(screen.queryByRole('button', { name: /Edit|Deactivate/ })).toBeNull();
  });

  it('adds a JPY option: the price field asks for whole yen, and what was typed goes to the action', async () => {
    shipActions.createShippingOptionAction.mockResolvedValue({ status: 'success', data: option() });
    const user = userEvent.setup();
    render(
      <CreateShippingOptionForm
        storeId={STORE}
        currencies={['JPY', 'USD']}
        defaultCurrency="JPY"
        defaultCountry="JP"
      />,
    );
    const form = screen.getByRole('form', { name: 'Add a shipping option' });
    expect(within(form).getByText('Amount in JPY, whole units')).toBeInTheDocument();
    await user.type(within(form).getByLabelText('Code'), 'standard');
    await user.type(within(form).getByLabelText('Name'), 'Standard');
    await user.type(within(form).getByLabelText('Price (JPY)'), '1980');
    await user.click(within(form).getByRole('button', { name: 'Add shipping option' }));

    expect(shipActions.createShippingOptionAction).toHaveBeenCalledWith(STORE, {
      code: 'standard',
      name: 'Standard',
      price: '1980',
      currency: 'JPY',
      countries: 'JP',
      is_active: true,
    });
    expect(await screen.findByRole('status')).toHaveTextContent(
      /^Added Standard: (JP)?¥1,980 to JP.$/,
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('switching to a two-decimal currency changes what the price field asks for', async () => {
    const user = userEvent.setup();
    render(
      <CreateShippingOptionForm
        storeId={STORE}
        currencies={['JPY', 'USD']}
        defaultCurrency="JPY"
        defaultCountry="JP"
      />,
    );
    await user.selectOptions(screen.getByLabelText('Currency'), 'USD');
    expect(screen.getByLabelText('Price (USD)')).toBeInTheDocument();
    expect(screen.getByText('Amount in USD')).toBeInTheDocument();
  });

  it('deactivating on a live store, refused by the core, is said in words and stays listed', async () => {
    shipActions.updateShippingOptionAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError:
        "Not saved: the store is live, and this would leave JP without an active shipping option in the store's currency — carts to JP could not check out. Add or keep another active option for JP first.",
    });
    const user = userEvent.setup();
    render(<ShippingOptionsTable storeId={STORE} options={[option()]} canManage locale="en-GB" />);
    await user.click(screen.getByRole('button', { name: 'Deactivate Standard (standard)' }));

    expect(shipActions.updateShippingOptionAction).toHaveBeenCalledWith(STORE, option().id, {
      name: 'Standard',
      price: '1980',
      countries: 'JP',
      is_active: false,
    });
    expect(
      await screen.findByText(/would leave JP without an active shipping option/),
    ).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('edits name, price and countries in one save', async () => {
    shipActions.updateShippingOptionAction.mockResolvedValue({ status: 'success', data: option() });
    const user = userEvent.setup();
    render(<ShippingOptionsTable storeId={STORE} options={[option()]} canManage locale="en-GB" />);
    await user.click(screen.getByRole('button', { name: 'Edit Standard (standard)' }));
    const form = screen.getByRole('form', { name: 'Edit Standard (standard)' });
    const price = within(form).getByLabelText('Price (JPY)');
    expect(price).toHaveValue('1980');
    await user.clear(price);
    await user.type(price, '2200');
    await user.type(within(form).getByLabelText('Countries'), ', KR');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(shipActions.updateShippingOptionAction.mock.calls[0]?.[2]).toEqual({
      name: 'Standard',
      price: '2200',
      countries: 'JP, KR',
      is_active: true,
    });
    expect(refresh).toHaveBeenCalled();
  });
});

describe('the readiness panel’s shipping step', () => {
  const panel = (over: { canCreateTax?: boolean; canCreateShipping?: boolean } = {}) =>
    render(
      <ActivatePanel
        storeId={STORE}
        status="draft"
        defaultCurrency="JPY"
        canCreateTax={over.canCreateTax ?? true}
        canCreateShipping={over.canCreateShipping ?? true}
      />,
    );

  it('names each uncovered country, creates one option per country in the store currency, then activates', async () => {
    storeActions.activateStoreAction
      .mockResolvedValueOnce(blocked(['shipping_options'], ['JP']))
      .mockResolvedValueOnce({ status: 'success', data: { id: STORE, status: 'active' } });
    shipActions.createCountryShippingOptionAction.mockResolvedValue({
      status: 'success',
      data: { outcome: 'created', option: option({ code: 'standard-jp' }) },
    });
    const user = userEvent.setup();
    panel();
    await user.click(screen.getByRole('button', { name: 'Activate' }));

    expect(await screen.findByRole('list', { name: 'Missing prerequisites' })).toHaveTextContent(
      'a shipping option for JP',
    );
    const step = screen.getByRole('region', { name: 'Shipping options to create' });
    expect(within(step).getByRole('link', { name: 'Settings › Shipping options' })).toHaveAttribute(
      'href',
      `/${STORE}/settings#shipping-options`,
    );
    const form = within(step).getByRole('form', { name: 'Create a shipping option for JP' });
    expect(within(form).getByText('Amount in JPY, whole units')).toBeInTheDocument();
    await user.type(within(form).getByLabelText('Price (JPY)'), '1980');
    await user.click(within(form).getByRole('button', { name: 'Create a shipping option for JP' }));
    expect(shipActions.createCountryShippingOptionAction).toHaveBeenCalledWith(STORE, {
      country: 'JP',
      currency: 'JPY',
      name: 'Standard',
      price: '1980',
    });
    expect(
      await within(step).findByText('JP: shipping option created (standard-jp).'),
    ).toBeInTheDocument();
    expect(within(step).getByText(/activate again/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    expect(storeActions.activateStoreAction).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalled();
  });

  it('without store_admin: the relation it needs, no create form — for tax and shipping alike', async () => {
    storeActions.activateStoreAction.mockResolvedValue(
      blocked(['tax_rates', 'shipping_options'], ['JP'], ['JP']),
    );
    const user = userEvent.setup();
    panel({ canCreateTax: false, canCreateShipping: false });
    await user.click(screen.getByRole('button', { name: 'Activate' }));

    const shipping = await screen.findByRole('region', { name: 'Shipping options to create' });
    expect(shipping).toHaveTextContent(
      `Creating shipping options needs store_admin on store:${STORE}.`,
    );
    expect(within(shipping).queryByRole('form')).toBeNull();
    const tax = screen.getByRole('region', { name: 'Tax rates to create' });
    expect(tax).toHaveTextContent(`Creating tax rates needs store_admin on store:${STORE}.`);
    expect(within(tax).queryByRole('form')).toBeNull();
  });

  it('a refused create stays on its form, in words', async () => {
    storeActions.activateStoreAction.mockResolvedValue(blocked(['shipping_options'], ['JP']));
    shipActions.createCountryShippingOptionAction.mockResolvedValue({
      status: 'error',
      fieldErrors: { price: 'JPY has no decimals.' },
      formError: null,
    });
    const user = userEvent.setup();
    panel();
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    const form = await screen.findByRole('form', { name: 'Create a shipping option for JP' });
    await user.type(within(form).getByLabelText('Price (JPY)'), '19.5');
    await user.click(within(form).getByRole('button', { name: 'Create a shipping option for JP' }));
    expect(await within(form).findByText('JPY has no decimals.')).toBeInTheDocument();
    expect(screen.queryByText(/JP: shipping option created/)).toBeNull();
  });

  it('an inactive standard option is reactivated rather than refused, and the panel says so', async () => {
    storeActions.activateStoreAction.mockResolvedValue(blocked(['shipping_options'], ['JP']));
    shipActions.createCountryShippingOptionAction.mockResolvedValue({
      status: 'success',
      data: { outcome: 'reactivated', option: option({ code: 'standard-jp' }) },
    });
    const user = userEvent.setup();
    panel();
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    const form = await screen.findByRole('form', { name: 'Create a shipping option for JP' });
    await user.type(within(form).getByLabelText('Price (JPY)'), '1980');
    await user.click(within(form).getByRole('button', { name: 'Create a shipping option for JP' }));
    expect(
      await screen.findByText('JP: the inactive option standard-jp was reactivated.'),
    ).toBeInTheDocument();
  });
});
