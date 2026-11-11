/**
 * #810: the promotion and price-list pages take the currency from the store, never from a fallback.
 * Money is parsed with the currency's digits, so the old `'EUR'` fallback on a failed store read made
 * `500` typed for a JPY store mean ¥50,000. Now a JPY store gets JPY (whole units), and a failed store
 * read renders the error panel with no money input and no currency at all — one test per site.
 */
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NewPromotionPage from '@/app/(store)/[storeId]/promotions/new/page';
import PromotionDetailPage from '@/app/(store)/[storeId]/promotions/[promotionId]/page';
import PriceListsPage from '@/app/(store)/[storeId]/promotions/price-lists/page';
import { SEED } from './fixtures/principals';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('@/components/shell/section-guard', () => ({
  StoreSectionGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/app/actions/promotions', () => ({
  createPromotionAction: vi.fn(),
  updatePromotionAction: vi.fn(),
  createPriceListAction: vi.fn(),
}));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals.storeAdmin,
  }),
}));
const api = vi.hoisted(() => ({
  getStore: vi.fn(),
  getPromotion: vi.fn(),
  listPriceLists: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const STORE = SEED.stores.brandA;
const PROMOTION = '60000000-0000-4000-8000-000000000001';
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const unavailable = {
  ok: false as const,
  status: 503,
  error: { code: 'unavailable', message: 'core unavailable' },
};
const jpyStore = ok({
  id: STORE,
  code: 'brand-d',
  default_currency: 'JPY',
  default_locale: 'ja-JP',
  currencies: ['JPY'],
  locales: ['ja-JP'],
  status: 'active',
});

beforeEach(() => {
  vi.clearAllMocks();
  api.listPriceLists.mockResolvedValue(ok({ items: [] }));
  api.getPromotion.mockResolvedValue(
    ok({
      id: PROMOTION,
      code: 'YEN500',
      name: 'Five hundred yen off',
      type: 'fixed_amount',
      value: 500,
      currency: 'JPY',
      status: 'active',
      usage_count: 0,
      usage_limit: null,
      stackable: false,
      exclusive: false,
      rules: {},
      starts_at: null,
      ends_at: null,
      created_at: '2026-11-11T00:00:00Z',
      updated_at: '2026-11-11T00:00:00Z',
    }),
  );
});

/** No money input and no guessed currency anywhere on the page. */
function expectNoMoneyInput() {
  expect(screen.queryByText(/^Amount in /)).toBeNull();
  expect(screen.queryByRole('textbox', { name: /Currency/ })).toBeNull();
  expect(document.body.textContent).not.toMatch(/\bEUR\b/);
}

describe('new promotion', () => {
  const page = () => NewPromotionPage({ params: Promise.resolve({ storeId: STORE }) });

  it('a JPY store: money is entered in whole yen', async () => {
    api.getStore.mockResolvedValue(jpyStore);
    render(await page());

    expect(screen.getByText('Amount in JPY, whole units')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create promotion' })).toBeInTheDocument();
  });

  it('a failed store read: the error panel, and no form to type an amount into', async () => {
    api.getStore.mockResolvedValue(unavailable);
    render(await page());

    expect(screen.queryByRole('button', { name: 'Create promotion' })).toBeNull();
    expect(screen.getByRole('heading')).toBeInTheDocument();
    expectNoMoneyInput();
  });
});

describe('promotion detail', () => {
  const page = () =>
    PromotionDetailPage({ params: Promise.resolve({ storeId: STORE, promotionId: PROMOTION }) });

  it('a JPY store: the edit form shows the amount in whole yen', async () => {
    api.getStore.mockResolvedValue(jpyStore);
    render(await page());

    expect(screen.getAllByText('Amount in JPY, whole units').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('a failed store read: the promotion still shows, the edit form does not', async () => {
    api.getStore.mockResolvedValue(unavailable);
    render(await page());

    expect(screen.getByRole('heading', { name: 'Five hundred yen off' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByText(/^Amount in /)).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Currency/ })).toBeNull();
  });
});

describe('price lists', () => {
  const page = () => PriceListsPage({ params: Promise.resolve({ storeId: STORE }) });

  it("a JPY store: a new list's currency is prefilled with JPY", async () => {
    api.getStore.mockResolvedValue(jpyStore);
    render(await page());

    expect(screen.getByRole('textbox', { name: /Currency/ })).toHaveValue('JPY');
  });

  it('a failed store read: the lists still show, the new-list form does not', async () => {
    api.getStore.mockResolvedValue(unavailable);
    render(await page());

    expect(screen.getByText('No price lists yet.')).toBeInTheDocument();
    expectNoMoneyInput();
  });
});
