import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StoreApi from '@/lib/store-api';
import type { Store } from '@/lib/store-api';

/**
 * The currency and locale round trip: switcher → cookie → `POST /store/carts`.
 *
 * This is the test that was missing when the switcher shipped reading `store.default_currency`
 * instead of the cookie. Nothing caught it because every layer was individually right — the cookie
 * was written, the cart was created correctly — and only the control that displays the choice was
 * wrong. So this walks the whole path rather than any single function.
 */

const STORE = {
  currencies: ['EUR', 'GBP'],
  default_currency: 'EUR',
  default_country: 'NL',
  default_locale: 'en-GB',
  locales: ['en-GB', 'de-DE'],
} as Store;

const cookieJar = new Map<string, string>();
let requestLocale = 'en-GB';

const createCart = vi.fn(async (body: unknown) => ({ id: 'cart-1', ...(body as object) }));
const getCartApi = vi.fn();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined,
    set: (name: string, value: string) => cookieJar.set(name, value),
    delete: (name: string) => cookieJar.delete(name),
  }),
}));

vi.mock('next-intl/server', () => ({
  getLocale: async () => requestLocale,
  // The switcher only needs the key back; the catalogue itself is covered in i18n.test.ts.
  getTranslations: async () => (key: string) => key,
}));

vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/store', () => ({
  getStoreOrNull: async () => STORE,
  getStore: async () => STORE,
}));

vi.mock('@/lib/store-api', async (importOriginal) => {
  const actual = await importOriginal<typeof StoreApi>();
  return { ...actual, storeApi: () => ({ createCart, getCart: getCartApi }) };
});

const { setCurrencyAction } = await import('@/lib/i18n-actions');
const { getOrCreateCart } = await import('@/lib/cart');
const { getCurrency, readCurrencyCookie } = await import('@/lib/i18n');
const { MarketSwitcher } = await import('@/components/market-switcher');

/** Walk a rendered element tree for the first node matching `type`. */
function findNode(node: unknown, type: string): { props: Record<string, unknown> } | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (element.type === type) return { props: element.props ?? {} };

  const children = element.props?.children;
  const list = Array.isArray(children) ? children : [children];
  for (const child of list.flat()) {
    const found = findNode(child, type);
    if (found) return found;
  }
  return undefined;
}

function form(currency: string): FormData {
  const data = new FormData();
  data.set('currency', currency);
  return data;
}

beforeEach(() => {
  cookieJar.clear();
  requestLocale = 'en-GB';
  createCart.mockClear();
  getCartApi.mockClear();
});

describe('currency round trip', () => {
  it('stores the chosen currency and reads it back for the switcher', async () => {
    await setCurrencyAction(form('GBP'));

    expect(cookieJar.get('currency')).toBe('GBP');
    // What the switcher renders as its selected value.
    expect(await readCurrencyCookie()).toBe('GBP');
    expect(await getCurrency(STORE)).toBe('GBP');
  });

  it('creates the cart in the chosen currency, not the store default', async () => {
    await setCurrencyAction(form('GBP'));
    await getOrCreateCart();

    expect(createCart).toHaveBeenCalledTimes(1);
    expect(createCart.mock.calls[0]?.[0]).toMatchObject({ currency: 'GBP' });
  });

  it('creates the cart in the locale being browsed, not the store default', async () => {
    requestLocale = 'de-DE';
    await getOrCreateCart();

    expect(createCart.mock.calls[0]?.[0]).toMatchObject({
      locale: 'de-DE',
      // Country is the market, not a preference: it stays the store's.
      country: 'NL',
    });
  });

  it('falls back to the store default before any choice is made', async () => {
    expect(await getCurrency(STORE)).toBe('EUR');
    await getOrCreateCart();
    expect(createCart.mock.calls[0]?.[0]).toMatchObject({ currency: 'EUR', locale: 'en-GB' });
  });

  it('shows the chosen currency in the switcher, not the store default', async () => {
    // The regression: the control read `store.default_currency`, so a customer who picked GBP saw
    // it snap back to EUR on the next render while their cookie and cart stayed on GBP.
    await setCurrencyAction(form('GBP'));

    const tree = await MarketSwitcher({ store: STORE });
    const select = findNode(tree, 'select');

    expect(select).toBeDefined();
    expect(select?.props.defaultValue).toBe('GBP');
  });

  it('refuses a currency the store does not sell in, at every layer', async () => {
    await setCurrencyAction(form('USD'));

    // The action validates before writing, so the bad value never reaches the cookie...
    expect(cookieJar.get('currency')).toBe('EUR');
    // ...and a hand-edited cookie is still reconciled before it reaches the API.
    cookieJar.set('currency', 'USD');
    expect(await getCurrency(STORE)).toBe('EUR');

    await getOrCreateCart();
    expect(createCart.mock.calls[0]?.[0]).toMatchObject({ currency: 'EUR' });
  });
});
