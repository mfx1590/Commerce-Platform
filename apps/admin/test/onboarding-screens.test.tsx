import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingWizard } from '@/app/(hq)/onboarding/onboarding-wizard';
import { ActivatePanel } from '@/app/(hq)/onboarding/[storeId]/activate-panel';
import { CanSellBox } from '@/app/(hq)/onboarding/[storeId]/can-sell';
import type { StoreReadiness } from '@/lib/readiness';

const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, back: vi.fn() }),
  usePathname: () => '/onboarding',
  redirect,
}));
const actions = vi.hoisted(() => ({ onboardStoreAction: vi.fn(), activateStoreAction: vi.fn() }));
vi.mock('@/app/actions/stores', () => actions);
const taxActions = vi.hoisted(() => ({
  createTaxRateAction: vi.fn(),
  updateTaxRateAction: vi.fn(),
  deleteTaxRateAction: vi.fn(),
}));
vi.mock('@/app/actions/tax-rates', () => taxActions);
const paymentActions = vi.hoisted(() => ({ updatePaymentSettingsAction: vi.fn() }));
vi.mock('@/app/actions/store-payment', () => paymentActions);
vi.mock('@/app/actions/shipping-options', () => ({
  createShippingOptionAction: vi.fn(),
  updateShippingOptionAction: vi.fn(),
}));

const STORE = '00000000-0000-4000-8000-000000000034';
const ENTITY = {
  id: '00000000-0000-4000-8000-000000000011',
  label: 'Brand A B.V. (le-brand-a, NL)',
};

beforeEach(() => vi.clearAllMocks());

/** Walks the wizard with valid values to the review step. */
async function walkToReview(user: ReturnType<typeof userEvent.setup>) {
  render(<OnboardingWizard legalEntities={[ENTITY]} />);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.type(screen.getByLabelText('Store code'), 'brand-c');
  await user.type(screen.getByLabelText('Store name'), 'Brand C');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.type(screen.getByRole('textbox', { name: 'Primary domain' }), 'brand-c.localhost');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByRole('region', { name: 'Review' })).toBeInTheDocument();
}

describe('the onboarding wizard', () => {
  it('a step does not advance with a bad field', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard legalEntities={[ENTITY]} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('Store code'), 'Brand C');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText(/Lowercase letters, digits and single hyphens/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Primary domain' })).toBeNull();
  });

  it('the 201 shows the key once; Done drops it and goes to readiness, never via the URL', async () => {
    const user = userEvent.setup();
    actions.onboardStoreAction.mockResolvedValue({
      status: 'success',
      data: {
        repeat: false,
        storeId: STORE,
        storeCode: 'brand-c',
        key: 'plain-words-one-time-value',
        keyPrefix: 'plainwords',
      },
    });
    await walkToReview(user);
    await user.click(screen.getByRole('button', { name: 'Onboard the brand' }));
    expect(actions.onboardStoreAction).toHaveBeenCalledWith(
      expect.objectContaining({
        legal_entity_mode: 'existing',
        legal_entity_id: ENTITY.id,
        code: 'brand-c',
        hostname: 'brand-c.localhost',
      }),
    );
    expect(await screen.findByTestId('onboarding-key')).toHaveTextContent(
      'plain-words-one-time-value',
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/shown once and cannot be retrieved again/);

    await user.click(screen.getByRole('button', { name: /Done/ }));
    expect(push).toHaveBeenCalledWith(`/onboarding/${STORE}`);
    expect(String(push.mock.calls[0]?.[0])).not.toContain('plain-words');
    expect(document.body.innerHTML).not.toContain('plain-words-one-time-value');
    // Until the route changes, the wizard says where it is going; it never falls back to the
    // Review step (#820: the brand D run saw Review flash after Done).
    expect(screen.queryByRole('region', { name: 'Review' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Onboard the brand' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Opening the readiness panel');
    expect(screen.getByRole('link', { name: 'Open it now' })).toHaveAttribute(
      'href',
      `/onboarding/${STORE}`,
    );
  });

  it('the 200 repeat says the store exists and shows no key', async () => {
    const user = userEvent.setup();
    actions.onboardStoreAction.mockResolvedValue({
      status: 'success',
      data: { repeat: true, storeId: STORE, storeCode: 'brand-c', key: null, keyPrefix: null },
    });
    await walkToReview(user);
    await user.click(screen.getByRole('button', { name: 'Onboard the brand' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      /already exists with exactly this definition/,
    );
    expect(screen.queryByTestId('onboarding-key')).toBeNull();
  });

  it('a 409 on a taken hostname puts the reader on the domain step, under the field', async () => {
    const user = userEvent.setup();
    actions.onboardStoreAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: 'hostname "brand-c.localhost" is already in use',
      details: { field: 'domain.hostname' },
    });
    await walkToReview(user);
    await user.click(screen.getByRole('button', { name: 'Onboard the brand' }));
    expect(await screen.findByRole('textbox', { name: 'Primary domain' })).toBeInTheDocument();
    expect(screen.getAllByText(/is already in use/).length).toBeGreaterThan(0);
  });

  it('a 409 "different definition" goes to the first step that owns what differs', async () => {
    const user = userEvent.setup();
    actions.onboardStoreAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: 'store "brand-c" already exists with a different definition',
      details: { field: 'code', differs: ['name', 'hostname'] },
    });
    await walkToReview(user);
    await user.click(screen.getByRole('button', { name: 'Onboard the brand' }));
    expect(await screen.findByLabelText('Store code')).toBeInTheDocument();
    expect(screen.getByText(/different definition/)).toBeInTheDocument();
  });

  it('a 422 lists each offending settings key on the store step', async () => {
    const user = userEvent.setup();
    actions.onboardStoreAction.mockResolvedValue({
      status: 'error',
      fieldErrors: {},
      formError: 'invalid store settings',
      details: { settings: { 'payment.invoice_allowed': 'boolean' } },
    });
    await walkToReview(user);
    await user.click(screen.getByRole('button', { name: 'Onboard the brand' }));
    expect(await screen.findByText('payment.invoice_allowed: boolean')).toBeInTheDocument();
  });
});

describe('the readiness panel', () => {
  it('lists exactly the 409 details.missing, and Activate succeeds when nothing is missing', async () => {
    const user = userEvent.setup();
    actions.activateStoreAction.mockResolvedValueOnce({
      status: 'error',
      fieldErrors: { status: 'Cannot activate: …' },
      formError: 'Cannot activate: …',
      missing: ['primary_domain', 'publishable_key'],
    });
    render(
      <ActivatePanel
        storeId={STORE}
        status="draft"
        defaultCurrency="EUR"
        canCreateTax
        canCreateShipping
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    const list = await screen.findByRole('list', { name: 'Missing prerequisites' });
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'a primary domain',
      'a live publishable key',
    ]);

    actions.activateStoreAction.mockResolvedValueOnce({
      status: 'success',
      data: { id: STORE, status: 'active' },
    });
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('an active store says so and offers nothing', () => {
    render(
      <ActivatePanel
        storeId={STORE}
        status="active"
        defaultCurrency="EUR"
        canCreateTax
        canCreateShipping
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/Active/);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

/** The generated `StoreReadiness` (Admin API 0.4.29). */
const readiness = (over: Partial<StoreReadiness> = {}): StoreReadiness => ({
  status: 'draft',
  missing: [],
  missing_tax_countries: [],
  missing_shipping_countries: [],
  payment_methods: [],
  purchasable_products: 0,
  warnings: [],
  ...over,
});

describe('the readiness panel with the readiness read (#830, #839 stand-in)', () => {
  it('lists what is missing before Activate is pressed, payment_method in words', () => {
    render(
      <ActivatePanel
        storeId={STORE}
        status="draft"
        defaultCurrency="JPY"
        canCreateTax
        canCreateShipping
        canEditPayment
        updatedAt="T1"
        readiness={readiness({ missing: ['payment_method'] })}
      />,
    );
    const list = screen.getByRole('list', { name: 'Missing prerequisites' });
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'a payment method customers can pay with (card or pay on invoice)',
    ]);
    const section = screen.getByRole('region', { name: 'Payment method to turn on' });
    expect(section.querySelector(`a[href="/${STORE}/settings#payment"]`)).not.toBeNull();
  });

  it('turns pay on invoice on inline with the rendered updated_at, then says activate again', async () => {
    const user = userEvent.setup();
    paymentActions.updatePaymentSettingsAction.mockResolvedValueOnce({
      status: 'success',
      data: { invoice_allowed: true, updated_at: 'T2' },
    });
    render(
      <ActivatePanel
        storeId={STORE}
        status="draft"
        defaultCurrency="EUR"
        canCreateTax
        canCreateShipping
        canEditPayment
        updatedAt="T1"
        readiness={readiness({ missing: ['payment_method'] })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Turn on pay on invoice' }));
    expect(paymentActions.updatePaymentSettingsAction).toHaveBeenCalledWith(STORE, {
      invoice_allowed: true,
      loaded_updated_at: 'T1',
    });
    expect(await screen.findByText('Pay on invoice is on — activate again.')).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it('a refused inline save is said, and the button stays', async () => {
    const user = userEvent.setup();
    paymentActions.updatePaymentSettingsAction.mockResolvedValueOnce({
      status: 'error',
      fieldErrors: {},
      formError:
        'The store was changed since this page was opened. Reload the page and try again — nothing was saved.',
    });
    render(
      <ActivatePanel
        storeId={STORE}
        status="draft"
        defaultCurrency="EUR"
        canCreateTax
        canCreateShipping
        canEditPayment
        updatedAt="T1"
        readiness={readiness({ missing: ['payment_method'] })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Turn on pay on invoice' }));
    expect(await screen.findByText(/changed since this page was opened/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn on pay on invoice' })).toBeInTheDocument();
  });

  it('below store_admin the payment step names the relation instead of a button', () => {
    render(
      <ActivatePanel
        storeId={STORE}
        status="draft"
        defaultCurrency="EUR"
        canCreateTax={false}
        canCreateShipping={false}
        readiness={readiness({ missing: ['payment_method'] })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Turn on pay on invoice' })).toBeNull();
    expect(screen.getByText(/Turning on pay on invoice needs/)).toBeInTheDocument();
  });

  it('pre-fills the countries from the readiness read (tax and shipping quick-creates show at once)', () => {
    render(
      <ActivatePanel
        storeId={STORE}
        status="draft"
        defaultCurrency="EUR"
        canCreateTax
        canCreateShipping
        readiness={readiness({
          missing: ['tax_rates', 'shipping_options'],
          missing_tax_countries: ['NL'],
          missing_shipping_countries: ['NL'],
        })}
      />,
    );
    const list = screen.getByRole('list', { name: 'Missing prerequisites' });
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'a tax rate for NL',
      'a shipping option for NL',
    ]);
    expect(screen.getByRole('region', { name: 'Tax rates to create' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Shipping options to create' })).toBeInTheDocument();
  });

  it('nothing missing in the read: no list until Activate answers (as before)', () => {
    render(
      <ActivatePanel
        storeId={STORE}
        status="draft"
        defaultCurrency="EUR"
        canCreateTax
        canCreateShipping
        readiness={readiness()}
      />,
    );
    expect(screen.queryByRole('list', { name: 'Missing prerequisites' })).toBeNull();
  });
});

describe('the can-sell box (#830)', () => {
  it('an active store with no product to buy is not selling, and says why with a link', () => {
    render(
      <CanSellBox
        storeId={STORE}
        readiness={readiness({
          status: 'active',
          payment_methods: ['invoice'],
          purchasable_products: 0,
          warnings: ['no_purchasable_product'],
        })}
      />,
    );
    const box = screen.getByRole('region', { name: 'Can this store sell' });
    expect(box).toHaveTextContent('Pay on invoice');
    expect(box).toHaveTextContent('0 products');
    expect(screen.getByRole('alert', { name: 'Warnings' })).toHaveTextContent(
      /No product can be bought yet/,
    );
    expect(screen.getByRole('link', { name: 'Open the catalogue' })).toHaveAttribute(
      'href',
      `/${STORE}/catalog`,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'the store is active, but a customer cannot',
    );
  });

  it('active, a method and a product: yes', () => {
    render(
      <CanSellBox
        storeId={STORE}
        readiness={readiness({
          status: 'active',
          payment_methods: ['card', 'invoice'],
          purchasable_products: 1,
        })}
      />,
    );
    expect(screen.getByRole('region', { name: 'Can this store sell' })).toHaveTextContent(
      'Card, Pay on invoice',
    );
    expect(screen.getByText('1 product')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Yes — customers can place an order.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('no payment method links to Settings › Payment; a draft store is not selling', () => {
    render(<CanSellBox storeId={STORE} readiness={readiness({ purchasable_products: 2 })} />);
    expect(screen.getByRole('link', { name: 'turn one on in Settings › Payment' })).toHaveAttribute(
      'href',
      `/${STORE}/settings#payment`,
    );
    expect(screen.queryByRole('alert', { name: 'Warnings' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Not yet — the store is not active.');
  });
});

describe('/stores/new', () => {
  it('redirects to the wizard', async () => {
    const { default: NewStorePage } = await import('@/app/(hq)/stores/new/page');
    try {
      NewStorePage();
    } catch {
      // next/navigation's redirect throws in the real thing; the mock records the call.
    }
    expect(redirect).toHaveBeenCalledWith('/onboarding');
  });
});
