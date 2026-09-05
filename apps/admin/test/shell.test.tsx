import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SideNav } from '@/components/shell/side-nav';
import { StoreSwitcher } from '@/components/shell/store-switcher';
import { hqNavItems, storeNavItems } from '@/lib/nav/navigation';
import { SEED, principals } from './fixtures/principals';

const pathname = vi.hoisted(() => ({ current: '/' }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
}));

// The switcher's submit handler is a server action; it is exercised on its own in
// select-store.test.ts. Here we only care about what the control offers.
vi.mock('@/app/actions/select-store', () => ({ selectStore: vi.fn() }));

beforeEach(() => {
  pathname.current = '/';
});

describe('SideNav', () => {
  it('renders only the sections it is given, in order', () => {
    render(<SideNav label="HQ" items={hqNavItems(principals.finance)} />);
    const nav = screen.getByRole('navigation', { name: 'HQ' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Stores', 'Finance']);
  });

  it('renders nothing at all for a principal with no sections in that scope', () => {
    const { container } = render(<SideNav label="HQ" items={hqNavItems(principals.storeAdmin)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('marks the current section for screen readers', () => {
    pathname.current = '/finance';
    render(<SideNav label="HQ" items={hqNavItems(principals.owner)} />);
    expect(screen.getByRole('link', { name: 'Finance' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Stores' })).not.toHaveAttribute('aria-current');
  });

  it('marks a store section from a nested path', () => {
    pathname.current = `/${SEED.stores.brandA}/catalog/some-product`;
    render(
      <SideNav label="Brand A" items={storeNavItems(principals.storeAdmin, SEED.stores.brandA)} />,
    );
    expect(screen.getByRole('link', { name: 'Catalog' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Orders' })).not.toHaveAttribute('aria-current');
  });

  it('does not offer Settings to store_staff', () => {
    render(
      <SideNav label="Brand A" items={storeNavItems(principals.storeStaff, SEED.stores.brandA)} />,
    );
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Content' })).toBeInTheDocument();
  });
});

describe('StoreSwitcher', () => {
  it('offers exactly the principal stores and nothing else', () => {
    render(<StoreSwitcher stores={principals.storeAdmin.stores} selectedStoreId={null} />);
    const options = within(screen.getByRole('combobox', { name: 'Store' })).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Brand A (brand-a)',
      'Brand B (brand-b)',
    ]);
    expect(options.map((option) => option.getAttribute('value'))).not.toContain(SEED.stores.brandC);
  });

  it('preselects the remembered store', () => {
    render(
      <StoreSwitcher stores={principals.storeAdmin.stores} selectedStoreId={SEED.stores.brandB} />,
    );
    expect(screen.getByRole('combobox', { name: 'Store' })).toHaveValue(SEED.stores.brandB);
  });

  it('is not rendered when the principal has no stores', () => {
    const { container } = render(
      <StoreSwitcher stores={principals.unassigned.stores} selectedStoreId={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('carries the current store section across the switch', () => {
    pathname.current = `/${SEED.stores.brandA}/orders`;
    render(<StoreSwitcher stores={principals.storeAdmin.stores} selectedStoreId={null} />);
    expect(document.querySelector('input[name="section"]')).toHaveValue('orders');
  });

  it('falls back to catalog when switching from an HQ page', () => {
    pathname.current = '/finance';
    render(<StoreSwitcher stores={principals.owner.stores} selectedStoreId={null} />);
    expect(document.querySelector('input[name="section"]')).toHaveValue('catalog');
  });
});
