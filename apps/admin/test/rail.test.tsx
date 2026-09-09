import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MedusaRail } from '@/components/rail/medusa-rail';
import styles from '@/components/rail/medusa-rail.module.css';
import { STORAGE } from '@/components/rail/rail.config';
import { hqNavItems, storeNavItems } from '@/lib/nav/navigation';
import { SEED, principals, type PrincipalKey } from './fixtures/principals';

const pathname = vi.hoisted(() => ({ current: '/' }));
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
  useRouter: () => ({ push, refresh: vi.fn(), back: vi.fn() }),
}));

/** Which media queries match in this test; `matchMedia` does not exist in jsdom. */
const media = { reduced: false, touch: false };

beforeEach(() => {
  pathname.current = `/${SEED.stores.brandA}/catalog`;
  media.reduced = false;
  media.touch = false;
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches:
      (query.includes('prefers-reduced-motion') && media.reduced) ||
      (query.includes('hover: none') && media.touch),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  // jsdom has no 2D canvas; the rail must cope with `getContext` answering null.
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(null);
  // Frames are driven by the pure geometry module; the loop itself is not what these tests probe.
  vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderRail(role: PrincipalKey, storeId: string | null = SEED.stores.brandA) {
  const principal = principals[role];
  return render(
    <MedusaRail
      hqItems={hqNavItems(principal)}
      storeItems={storeId === null ? [] : storeNavItems(principal, storeId)}
      storeName={
        storeId === null
          ? null
          : (principal.stores.find((s) => s.store_id === storeId)?.name ?? null)
      }
      userName={principal.user.display_name}
    />,
  );
}

const serpents = () =>
  screen.queryAllByRole('button').filter((b) => b.hasAttribute('data-section'));
const serpentNames = () => serpents().map((b) => b.getAttribute('aria-label'));

describe('the rail is the permission model made visible', () => {
  it('store_staff grows no Settings serpent', () => {
    renderRail('storeStaff');
    expect(serpentNames()).toContain('Catalog');
    expect(serpentNames()).toContain('Content');
    expect(serpentNames()).not.toContain('Settings');
    // No HQ items at all, so there is no scope to switch to.
    expect(screen.queryByRole('group', { name: 'Scope' })).toBeNull();
  });

  it('analyst grows no Customers serpent', () => {
    renderRail('analyst');
    expect(serpentNames()).not.toContain('Customers');
    expect(serpentNames()).toContain('Catalog');
  });

  it('store_admin never sees Finance, in any scope', () => {
    renderRail('storeAdmin');
    expect(serpentNames()).not.toContain('Finance');
    expect(screen.queryByRole('group', { name: 'Scope' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'HQ' })).toBeNull();
  });

  it('renders exactly the sections it is given, in order, as buttons inside a named nav', () => {
    renderRail('finance');
    const nav = screen.getByRole('navigation', { name: 'Brand A' });
    expect(
      within(nav)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(storeNavItems(principals.finance, SEED.stores.brandA).map((item) => item.label));
  });
});

describe('scope switch', () => {
  it('follows the URL: an HQ path shows the HQ serpents with the current one pressed', () => {
    pathname.current = '/finance';
    renderRail('owner');
    expect(screen.getByRole('navigation', { name: 'HQ' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finance' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Stores' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'HQ' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('swaps the serpent set without navigating, and nothing is pressed in the other scope', async () => {
    const user = userEvent.setup();
    pathname.current = '/finance';
    renderRail('owner');

    await user.click(screen.getByRole('button', { name: 'Store' }));
    expect(screen.getByRole('navigation', { name: 'Brand A' })).toBeInTheDocument();
    expect(serpentNames()).toContain('Catalog');
    expect(serpents().every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(push).not.toHaveBeenCalled();
  });
});

describe('every serpent is keyboard-operable', () => {
  it('Enter and Space navigate, a click navigates, and the pressed state names the current section', async () => {
    const user = userEvent.setup();
    renderRail('storeAdmin');

    const catalog = screen.getByRole('button', { name: 'Catalog' });
    const orders = screen.getByRole('button', { name: 'Orders' });
    expect(catalog).toHaveAttribute('aria-pressed', 'true');
    expect(orders).toHaveAttribute('aria-pressed', 'false');
    expect(orders).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(orders, { key: 'Enter' });
    expect(push).toHaveBeenLastCalledWith(`/${SEED.stores.brandA}/orders`);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Settings' }), { key: ' ' });
    expect(push).toHaveBeenLastCalledWith(`/${SEED.stores.brandA}/settings`);
    await user.click(screen.getByRole('button', { name: 'Promotions' }));
    expect(push).toHaveBeenLastCalledWith(`/${SEED.stores.brandA}/promotions`);
    // Other keys do nothing.
    fireEvent.keyDown(orders, { key: 'a' });
    expect(push).toHaveBeenCalledTimes(3);
  });

  it('carries a focus ring element for every serpent', () => {
    const { container } = renderRail('storeAdmin');
    expect(container.querySelectorAll('[data-part="ring"]')).toHaveLength(serpents().length);
  });
});

describe('list view', () => {
  it('is off by default on a pointer device and persists when switched on', async () => {
    const user = userEvent.setup();
    const { unmount } = renderRail('storeAdmin');
    expect(screen.queryByRole('link', { name: 'Catalog' })).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: 'List view' }));
    const nav = screen.getByRole('navigation', { name: 'Brand A' });
    expect(within(nav).getByRole('link', { name: 'Catalog' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Orders' })).not.toHaveAttribute('aria-current');
    expect(serpents()).toHaveLength(0);
    expect(window.localStorage.getItem(STORAGE.listView)).toBe('1');

    unmount();
    renderRail('storeAdmin');
    expect(screen.getByRole('link', { name: 'Catalog' })).toBeInTheDocument();
  });

  it('is the default on a touch device', () => {
    media.touch = true;
    renderRail('storeAdmin');
    expect(screen.getByRole('link', { name: 'Catalog' })).toBeInTheDocument();
  });

  it('takes over under prefers-reduced-motion, with the toggle locked on and no motion set up', () => {
    media.reduced = true;
    const { container } = renderRail('storeAdmin');
    expect(screen.getByRole('link', { name: 'Catalog' })).toBeInTheDocument();
    expect(serpents()).toHaveLength(0);
    const toggle = screen.getByRole('checkbox', { name: 'List view' });
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    expect(container.querySelector('canvas')).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE.introSeen)).toBeNull();
    expect(screen.getByRole('complementary')).toHaveAttribute('data-intro', 'done');
  });
});

describe('the load sequence', () => {
  it('plays once per session: the first mount grows the serpents, the next does not', () => {
    const { unmount, container } = renderRail('storeAdmin');
    const first = container.querySelector<SVGGElement>('[data-section="catalog"]');
    expect(first?.classList.contains(styles.grow ?? '')).toBe(true);
    expect(first?.style.getPropertyValue('--len')).not.toBe('');
    expect(first?.style.getPropertyValue('--delay')).toBe('0.90s');
    expect(window.sessionStorage.getItem(STORAGE.introSeen)).toBe('1');
    expect(window.requestAnimationFrame).toHaveBeenCalled();
    expect(screen.getByRole('complementary')).toHaveAttribute('data-intro', 'playing');

    unmount();
    const again = renderRail('storeAdmin');
    const second = again.container.querySelector<SVGGElement>('[data-section="catalog"]');
    expect(second?.classList.contains(styles.grow ?? '')).toBe(false);
    expect(again.getByRole('complementary')).toHaveAttribute('data-intro', 'done');
  });

  it('staggers each serpent by 160 ms after the head', () => {
    const { container } = renderRail('storeAdmin');
    const delays = Array.from(container.querySelectorAll<SVGGElement>('[data-section]')).map((g) =>
      g.style.getPropertyValue('--delay'),
    );
    expect(delays.slice(0, 3)).toEqual(['0.90s', '1.06s', '1.22s']);
  });
});

describe('accessibility (axe)', () => {
  // Colour contrast needs a layout engine and real stylesheets, which jsdom does not have; the
  // token pairs are measured in globals.css instead.
  const options = { rules: { 'color-contrast': { enabled: false } } };

  it('passes on the serpent view', async () => {
    const { container } = renderRail('owner');
    const results = await act(() => axe.run(container, options));
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(',')}`),
    ).toEqual([]);
  });

  it('passes on the list view', async () => {
    media.reduced = true;
    const { container } = renderRail('owner');
    const results = await act(() => axe.run(container, options));
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe('the foot', () => {
  it('names the signed-in principal once', () => {
    renderRail('storeAdmin');
    expect(screen.getByText('Sam StoreAdmin')).toBeInTheDocument();
  });
});
