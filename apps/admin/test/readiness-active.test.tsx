/**
 * #910: an ACTIVE store that loses a prerequisite. The readiness panel says "Customers cannot currently
 * order: …" with where to fix it, instead of "the store is live". The can-sell box says no, a warning
 * the contract does not declare yet is listed generically, and a failed readiness read says it
 * "could not check" instead of going quiet.
 */
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreReadiness } from '@/lib/readiness';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/onboarding/x',
  redirect: vi.fn(),
}));
vi.mock('@/app/actions/stores', () => ({
  activateStoreAction: vi.fn(),
  onboardStoreAction: vi.fn(),
}));
vi.mock('@/app/actions/store-payment', () => ({ updatePaymentSettingsAction: vi.fn() }));
vi.mock('@/app/actions/tax-rates', () => ({
  createTaxRateAction: vi.fn(),
  updateTaxRateAction: vi.fn(),
  deleteTaxRateAction: vi.fn(),
}));
vi.mock('@/app/actions/shipping-options', () => ({
  createShippingOptionAction: vi.fn(),
  createCountryShippingOptionAction: vi.fn(),
  updateShippingOptionAction: vi.fn(),
}));
vi.mock('@/components/shell/section-guard', () => ({
  HqSectionGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals.owner,
  }),
}));
const api = vi.hoisted(() => ({ getStore: vi.fn(), getStoreReadiness: vi.fn() }));
vi.mock('@/lib/api/admin', () => api);

const { ActivatePanel } = await import('@/app/(hq)/onboarding/[storeId]/activate-panel');
const { CanSellBox } = await import('@/app/(hq)/onboarding/[storeId]/can-sell');
const { default: ReadinessPage } = await import('@/app/(hq)/onboarding/[storeId]/page');

const STORE = '00000000-0000-4000-8000-000000000034';

const readiness = (over: Partial<StoreReadiness> = {}): StoreReadiness => ({
  status: 'active',
  missing: [],
  missing_tax_countries: [],
  missing_shipping_countries: [],
  payment_methods: ['card'],
  purchasable_products: 4,
  warnings: [],
  ...over,
});

/** An active store that went live, then lost its German tax rate and its payment method. */
const lost = readiness({
  missing: ['tax_rates', 'payment_method'],
  missing_tax_countries: ['DE'],
  payment_methods: [],
});

const panel = (r: StoreReadiness | null) =>
  render(
    <ActivatePanel
      storeId={STORE}
      status="active"
      defaultCurrency="EUR"
      canCreateTax
      canCreateShipping
      readiness={r}
    />,
  );

describe('the readiness panel for an ACTIVE store (#910)', () => {
  it('a lost prerequisite reads "Customers cannot currently order", never "the store is live"', () => {
    panel(lost);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'Customers cannot currently order: a tax rate for DE, a payment method customers can pay with (card or pay on invoice) missing.',
    );
    expect(screen.queryByText(/the store is live/)).toBeNull();
    // Nothing here deactivates the store or re-offers Activate.
    expect(screen.queryByRole('button')).toBeNull();
    const fixes = within(screen.getByRole('list', { name: 'Where to fix it' }));
    expect(fixes.getByRole('link', { name: 'Settings › Tax rates' })).toHaveAttribute(
      'href',
      `/${STORE}/settings`,
    );
    expect(fixes.getByRole('link', { name: 'Settings › Payment' })).toHaveAttribute(
      'href',
      `/${STORE}/settings#payment`,
    );
  });

  it('a lost shipping option links to Settings › Shipping options', () => {
    panel(readiness({ missing: ['shipping_options'], missing_shipping_countries: ['FR'] }));
    expect(screen.getByRole('alert')).toHaveTextContent('a shipping option for FR missing');
    expect(screen.getByRole('link', { name: 'Settings › Shipping options' })).toHaveAttribute(
      'href',
      `/${STORE}/settings#shipping-options`,
    );
  });

  it('nothing missing is still "the store is live"', () => {
    panel(readiness());
    expect(screen.getByRole('status')).toHaveTextContent('Active — the store is live.');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the can-sell box for an active store missing something (#910)', () => {
  it('says no, even with a payment method and products', () => {
    render(
      <CanSellBox
        storeId={STORE}
        readiness={readiness({ missing: ['shipping_options'], missing_shipping_countries: ['FR'] })}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'No — the store is active, but customers cannot currently order',
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('Yes');
  });

  it('lists a warning the contract does not declare yet, generically', () => {
    render(
      <CanSellBox storeId={STORE} readiness={readiness({ other_warnings: ['later_warning'] })} />,
    );
    expect(screen.getByRole('alert', { name: 'Warnings' })).toHaveTextContent(
      'The core reported a warning this admin cannot describe yet: later_warning.',
    );
  });
});

describe('the readiness page (#910)', () => {
  const store = (status: string) => ({
    ok: true,
    status: 200,
    data: {
      id: STORE,
      name: 'Brand D',
      code: 'brand-d',
      status,
      default_currency: 'JPY',
      updated_at: '2026-11-19T10:00:00Z',
    },
  });
  const params = { params: Promise.resolve({ storeId: STORE }) };

  beforeEach(() => {
    api.getStore.mockReset();
    api.getStoreReadiness.mockReset();
  });

  it('a failed readiness read says it could not check, never "the store is live" alone', async () => {
    api.getStore.mockResolvedValue(store('active'));
    api.getStoreReadiness.mockResolvedValue({
      ok: false,
      status: 503,
      error: { code: 'unavailable', message: 'down' },
    });
    render(await ReadinessPage(params));
    expect(screen.getByRole('status', { name: 'Readiness check' })).toHaveTextContent(
      'Could not check whether this store can sell (503). What is missing and whether customers can order are unknown, not fine: reload to try again.',
    );
    expect(screen.queryByRole('region', { name: 'Can this store sell' })).toBeNull();
  });

  it('a draft store with a failed read also says Activate still asks the core', async () => {
    api.getStore.mockResolvedValue(store('draft'));
    api.getStoreReadiness.mockResolvedValue({
      ok: false,
      status: 0,
      error: { code: 'network', message: 'no answer' },
    });
    render(await ReadinessPage(params));
    const note = screen.getByRole('status', { name: 'Readiness check' });
    expect(note).toHaveTextContent('Could not check whether this store can sell.');
    expect(note).toHaveTextContent('Activate still asks the core.');
  });

  it('an active store that lost a prerequisite shows both the panel and the box', async () => {
    api.getStore.mockResolvedValue(store('active'));
    api.getStoreReadiness.mockResolvedValue({ ok: true, status: 200, data: lost });
    render(await ReadinessPage(params));
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('Customers cannot currently order');
    expect(screen.getByRole('region', { name: 'Can this store sell' })).toHaveTextContent(
      'No — the store is active',
    );
    expect(screen.queryByRole('status', { name: 'Readiness check' })).toBeNull();
  });
});
