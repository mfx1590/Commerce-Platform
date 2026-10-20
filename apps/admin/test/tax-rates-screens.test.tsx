/**
 * Tax rates on screen (#520): the readiness panel turns activateStore's 409 `tax_rates` into one
 * "Create a rate for XX" form per uncovered market country; Store settings lists, edits, deletes
 * (asking first; the last-rate 409 said) and adds rates.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivatePanel } from '@/app/(hq)/onboarding/[storeId]/activate-panel';
import { CreateTaxRateForm, TaxRatesTable } from '@/components/tax-rates/tax-rate-forms';
import { describeTaxRateError } from '@/lib/tax-rates';

vi.mock('server-only', () => ({}));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/',
}));
const storeActions = vi.hoisted(() => ({ activateStoreAction: vi.fn() }));
vi.mock('@/app/actions/stores', () => storeActions);
const taxActions = vi.hoisted(() => ({
  createTaxRateAction: vi.fn(),
  updateTaxRateAction: vi.fn(),
  deleteTaxRateAction: vi.fn(),
}));
vi.mock('@/app/actions/tax-rates', () => taxActions);

const STORE = '00000000-0000-4000-8000-000000000034';
const rate = (over: Record<string, unknown> = {}) => ({
  id: '75000000-0000-4000-8000-000000000001',
  country: 'NL',
  region: null,
  name: 'VAT 21%',
  rate_bp: 2100,
  product_category_id: null,
  created_at: '2026-10-20T00:00:00Z',
  updated_at: '2026-10-20T00:00:00Z',
  ...over,
});
const blocked = (missing: string[], countries?: string[]) => ({
  status: 'error' as const,
  fieldErrors: {},
  formError: 'Cannot activate.',
  missing,
  ...(countries === undefined ? {} : { missingTaxCountries: countries }),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the readiness panel’s tax step', () => {
  it('lists each uncovered country with its own create form, ticks it off, then activates', async () => {
    storeActions.activateStoreAction
      .mockResolvedValueOnce(blocked(['tax_rates'], ['BE', 'NL']))
      .mockResolvedValueOnce({ status: 'success', data: { id: STORE, status: 'active' } });
    taxActions.createTaxRateAction.mockImplementation(
      async (_s: string, v: { country: string }) => ({
        status: 'success',
        data: rate({ country: v.country }),
      }),
    );
    const user = userEvent.setup();
    render(<ActivatePanel storeId={STORE} status="draft" />);
    await user.click(screen.getByRole('button', { name: 'Activate' }));

    const missing = await screen.findByRole('list', { name: 'Missing prerequisites' });
    expect(missing).toHaveTextContent('a tax rate for BE, NL');
    const step = screen.getByRole('region', { name: 'Tax rates to create' });
    for (const country of ['BE', 'NL']) {
      const form = within(step).getByRole('form', { name: `Create a rate for ${country}` });
      await user.type(within(form).getByLabelText('Rate (basis points)'), '2100');
      expect(within(form).getByText('2100 bp = 21%')).toBeInTheDocument();
      await user.click(within(form).getByRole('button', { name: `Create a rate for ${country}` }));
      expect(await within(step).findByText(`${country}: rate created.`)).toBeInTheDocument();
    }
    expect(taxActions.createTaxRateAction).toHaveBeenCalledWith(STORE, {
      country: 'NL',
      name: 'VAT',
      rate_bp: '2100',
    });
    expect(within(step).getByText(/activate again/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    expect(storeActions.activateStoreAction).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalled();
  });

  it('a refused create stays on its form, in words', async () => {
    storeActions.activateStoreAction.mockResolvedValue(blocked(['tax_rates'], ['NL']));
    taxActions.createTaxRateAction.mockResolvedValue({
      status: 'error',
      fieldErrors: { rate_bp: 'At most 10000 basis points (100%).' },
      formError: null,
    });
    const user = userEvent.setup();
    render(<ActivatePanel storeId={STORE} status="draft" />);
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    const form = await screen.findByRole('form', { name: 'Create a rate for NL' });
    await user.type(within(form).getByLabelText('Rate (basis points)'), '20000');
    await user.click(within(form).getByRole('button', { name: 'Create a rate for NL' }));
    expect(await within(form).findByText('At most 10000 basis points (100%).')).toBeInTheDocument();
    expect(screen.queryByText('NL: rate created.')).toBeNull();
  });

  it('no tax step when the 409 does not name tax rates', async () => {
    storeActions.activateStoreAction.mockResolvedValue(blocked(['primary_domain']));
    const user = userEvent.setup();
    render(<ActivatePanel storeId={STORE} status="draft" />);
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    await screen.findByRole('list', { name: 'Missing prerequisites' });
    expect(screen.queryByRole('region', { name: 'Tax rates to create' })).toBeNull();
  });
});

describe('the Store settings tax-rate table', () => {
  const categories = [{ id: '20000000-0000-4000-8000-000000000201', name: 'Books' }];
  const rates = [
    rate(),
    rate({
      id: '75000000-0000-4000-8000-000000000002',
      country: 'NL',
      name: 'Books 9%',
      rate_bp: 900,
      product_category_id: categories[0]!.id,
    }),
    rate({
      id: '75000000-0000-4000-8000-000000000003',
      country: 'US',
      region: 'CA',
      name: 'CA',
      rate_bp: 725,
    }),
  ];

  it('lists country, region, category, name and rate in bp and %', () => {
    render(<TaxRatesTable storeId={STORE} rates={rates} canManage categories={categories} />);
    const rows = within(screen.getByRole('table', { name: 'Tax rates' }))
      .getAllByRole('row')
      .slice(1);
    expect(rows[0]).toHaveTextContent(/NL.*country-wide.*all.*VAT 21%.*2100 bp.*\(21%\)/);
    expect(rows[1]).toHaveTextContent(/Books.*Books 9%.*900 bp.*\(9%\)/);
    expect(rows[2]).toHaveTextContent(/US.*CA.*725 bp.*\(7.25%\)/);
  });

  it('a reader without store_admin sees no Edit or Delete', () => {
    render(
      <TaxRatesTable storeId={STORE} rates={rates} canManage={false} categories={categories} />,
    );
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete / })).toBeNull();
  });

  it('an empty list says what it means', () => {
    render(<TaxRatesTable storeId={STORE} rates={[]} canManage categories={[]} />);
    expect(screen.getByText(/taxed at 0%, and the store cannot be activated/)).toBeInTheDocument();
  });

  it('edits name and bp only', async () => {
    taxActions.updateTaxRateAction.mockResolvedValue({ status: 'success', data: rate() });
    const user = userEvent.setup();
    render(<TaxRatesTable storeId={STORE} rates={[rate()]} canManage categories={[]} />);
    await user.click(screen.getByRole('button', { name: 'Edit VAT 21% (NL)' }));
    const form = screen.getByRole('form', { name: 'Edit VAT 21% (NL)' });
    await user.clear(within(form).getByLabelText('Rate (basis points)'));
    await user.type(within(form).getByLabelText('Rate (basis points)'), '2000');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(taxActions.updateTaxRateAction).toHaveBeenCalledWith(STORE, rate().id, {
      name: 'VAT 21%',
      rate_bp: '2000',
    });
    expect(within(form).queryByLabelText('Country')).toBeNull();
  });

  it('delete asks first; the last-rate 409 is said with the way out', async () => {
    taxActions.deleteTaxRateAction.mockResolvedValue({
      status: 'error',
      ...describeTaxRateError({
        status: 409,
        error: {
          code: 'conflict',
          message: 'last rate',
          details: { country: 'NL', reason: 'last_rate_of_market_country' },
        },
      }),
    });
    const user = userEvent.setup();
    render(<TaxRatesTable storeId={STORE} rates={[rate()]} canManage categories={[]} />);
    await user.click(screen.getByRole('button', { name: 'Delete VAT 21% (NL)' }));
    expect(
      screen.getByRole('alertdialog', { name: 'Confirm deleting VAT 21% (NL)' }),
    ).toBeInTheDocument();
    expect(taxActions.deleteTaxRateAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(
      await screen.findByText(
        'This is the last rate for NL on an active store: removing it would tax NL at 0%. Add another rate for NL first.',
      ),
    ).toBeInTheDocument();
  });
});

describe('Add a tax rate', () => {
  it('starts from the store’s default country and sends every field', async () => {
    taxActions.createTaxRateAction.mockResolvedValue({ status: 'success', data: rate() });
    const user = userEvent.setup();
    render(
      <CreateTaxRateForm
        storeId={STORE}
        defaultCountry="NL"
        categories={[{ id: '20000000-0000-4000-8000-000000000201', name: 'Books' }]}
      />,
    );
    const form = screen.getByRole('form', { name: 'Add a tax rate' });
    expect(within(form).getByLabelText('Country')).toHaveValue('NL');
    await user.selectOptions(within(form).getByLabelText('Category (optional)'), 'Books');
    await user.type(within(form).getByLabelText('Rate (basis points)'), '900');
    await user.click(within(form).getByRole('button', { name: 'Add rate' }));
    expect(taxActions.createTaxRateAction).toHaveBeenCalledWith(STORE, {
      country: 'NL',
      region: '',
      product_category_id: '20000000-0000-4000-8000-000000000201',
      name: 'VAT',
      rate_bp: '900',
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Added VAT 21% for NL (21%).');
  });

  it('a duplicate is said at form level', async () => {
    taxActions.createTaxRateAction.mockResolvedValue({
      status: 'error',
      ...describeTaxRateError({
        status: 409,
        error: { code: 'conflict', message: 'exists', details: { tax_rate_id: rate().id } },
      }),
    });
    const user = userEvent.setup();
    render(<CreateTaxRateForm storeId={STORE} defaultCountry="NL" categories={[]} />);
    await user.type(screen.getByLabelText('Rate (basis points)'), '2100');
    await user.click(screen.getByRole('button', { name: 'Add rate' }));
    expect(await screen.findByText(/already exists — edit that one instead/)).toBeInTheDocument();
  });
});
