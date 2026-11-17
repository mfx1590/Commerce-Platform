/**
 * #675 review, finding 1: after a save outside the Details form (the AI panel's), the page re-renders
 * with the saved product. The Details form is keyed by `updated_at`, so it remounts on the saved
 * values and a later "Save changes" can never write the old title or description back.
 */
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProductDetailPage from '@/app/(store)/[storeId]/catalog/[productId]/page';
import { SEED } from './fixtures/principals';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('@/components/shell/section-guard', () => ({
  StoreSectionGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/app/actions/catalog', () => ({
  updateProductAction: vi.fn(),
  publishProductAction: vi.fn(),
  archiveProductAction: vi.fn(),
  createVariantAction: vi.fn(),
  updateVariantAction: vi.fn(),
}));
vi.mock('@/app/actions/copy-drafts', () => ({
  draftProductCopyAction: vi.fn(),
  saveProductCopyAction: vi.fn(),
}));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals.storeStaff,
  }),
}));
const api = vi.hoisted(() => ({
  getProduct: vi.fn(),
  getStore: vi.fn(),
  listCategories: vi.fn(),
  // #870 item 3: the detail page now carries an Activity panel.
  listAuditLog: vi.fn(),
  listUsers: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const STORE = SEED.stores.brandA;
const PRODUCT = '50000000-0000-4000-8000-000000000001';
const product = (title: string, updatedAt: string) => ({
  id: PRODUCT,
  handle: 'tea-towel',
  title,
  subtitle: null,
  description: `${title} description.`,
  status: 'draft',
  category_id: null,
  brand_name: null,
  tags: [],
  attributes: {},
  seo: {},
  thumbnail_url: null,
  options: [],
  variants: [],
  media: [],
  published_at: null,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: updatedAt,
});
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

beforeEach(() => {
  vi.clearAllMocks();
  api.listAuditLog.mockResolvedValue(ok({ page: 1, limit: 20, total: 0, items: [] }));
  api.listUsers.mockResolvedValue(ok({ page: 1, limit: 100, total: 0, items: [] }));
  api.listCategories.mockResolvedValue(ok({ items: [] }));
  api.getStore.mockResolvedValue(
    ok({ id: STORE, default_locale: 'en-GB', locales: ['en-GB'], status: 'active' }),
  );
});

const page = () =>
  ProductDetailPage({ params: Promise.resolve({ storeId: STORE, productId: PRODUCT }) });

describe('the Details form after a save elsewhere on the page', () => {
  it('shows the saved values, not the stale ones it was mounted with', async () => {
    api.getProduct.mockResolvedValue(ok(product('Old title', '2026-11-01T10:00:00Z')));
    const view = render(await page());
    expect(screen.getByRole('textbox', { name: /^Title/ })).toHaveValue('Old title');

    // The AI panel saved; router.refresh() re-renders the page with the saved product.
    api.getProduct.mockResolvedValue(ok(product('Saved title', '2026-11-01T10:05:00Z')));
    view.rerender(await page());
    expect(screen.getByRole('textbox', { name: /^Title/ })).toHaveValue('Saved title');
    expect(screen.getByRole('textbox', { name: /^Description/ })).toHaveValue(
      'Saved title description.',
    );
  });
});
