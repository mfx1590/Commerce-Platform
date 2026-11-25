/**
 * `saveStoreSettingsAction` (#870 item 7, PR A).
 *
 * The rules worth holding are all about what reaches the API:
 *
 * - **only the named card's paths**, so a crafted request cannot write another card's setting, or
 *   `payment.methods`, which the core refuses anyway;
 * - **the whole settings object, merged** — `updateStore` replaces the column wholesale, so every
 *   other module's keys must come back untouched;
 * - **a stale page is refused** by `updated_at`, before anything is written;
 * - **a consequential change must arrive confirmed**: the diff dialog is UI, this is the check.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED, type PrincipalKey } from './fixtures/principals';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const principalOf = vi.hoisted(() => ({ current: 'storeAdmin' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true as const,
    status: 200,
    data: (await import('./fixtures/principals')).principals[principalOf.current as PrincipalKey],
  }),
}));

const api = vi.hoisted(() => ({ getStore: vi.fn(), updateStore: vi.fn() }));
vi.mock('@/lib/api/admin', () => api);

const { saveStoreSettingsAction } = await import('@/app/actions/store-settings');

const STORE = SEED.stores.brandA;
const LOADED = '2026-11-25T10:00:00.000Z';

const ok = <T>(data: T) => ({ ok: true as const, status: 200, data });

/** Settings as several modules left them: a save must not lose any of this. */
const SETTINGS = {
  payment: { invoice_allowed: true, methods: ['card'] },
  tax: { provider: 'table', prices_include_tax: false, shipping_taxable: true },
  fraud: { providers: ['rules'], velocity: { max_orders: 5, window_minutes: 60 } },
  shipping: { provider: 'easypost', carrier_account_ids: ['ca_1'] },
  fulfillment: { provider: 'memory', routing: { default: 'wh-eu' } },
  support_refund_limit_minor: 5000,
  content: { brand_voice: 'Plain and precise.' },
  something_another_module_added: { keep: true },
};

const store = (over: Record<string, unknown> = {}) => ({
  id: STORE,
  code: 'brand-a',
  name: 'Brand A',
  default_currency: 'EUR',
  settings: SETTINGS,
  updated_at: LOADED,
  ...over,
});

const sentSettings = () =>
  (api.updateStore.mock.calls[0]?.[1] as { settings: Record<string, unknown> }).settings;

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'storeAdmin';
  api.getStore.mockResolvedValue(ok(store()));
  api.updateStore.mockImplementation(async (_id: string, patch: { settings: unknown }) =>
    ok(store({ settings: patch.settings, updated_at: '2026-11-25T11:00:00.000Z' })),
  );
});

describe('what reaches the API', () => {
  it('keeps every other key, and drops the derived payment.methods', async () => {
    const result = await saveStoreSettingsAction(
      STORE,
      'tax',
      { 'tax.shipping_taxable': false },
      LOADED,
      false,
    );
    expect(result.status).toBe('success');

    const sent = sentSettings();
    expect(sent['tax']).toEqual({
      provider: 'table',
      prices_include_tax: false,
      shipping_taxable: false,
    });
    // Everything another module owns survives the write.
    expect(sent['fraud']).toEqual(SETTINGS.fraud);
    expect(sent['shipping']).toEqual(SETTINGS.shipping);
    expect(sent['fulfillment']).toEqual(SETTINGS.fulfillment);
    expect(sent['support_refund_limit_minor']).toBe(5000);
    expect(sent['something_another_module_added']).toEqual({ keep: true });
    // Derived, and refused by the core when written.
    expect(sent['payment']).toEqual({ invoice_allowed: true });
  });

  it('ignores a path that does not belong to the named card', async () => {
    await saveStoreSettingsAction(
      STORE,
      'tax',
      {
        'tax.shipping_taxable': false,
        support_refund_limit_minor: 999_999,
        'payment.methods': ['card', 'invoice'],
        'fraud.providers': [],
      },
      LOADED,
      true,
    );
    const sent = sentSettings();
    expect(sent['support_refund_limit_minor']).toBe(5000);
    expect(sent['fraud']).toEqual(SETTINGS.fraud);
    expect(sent['payment']).toEqual({ invoice_allowed: true });
  });

  it('clears a text setting by deleting the path, not by storing an empty string', async () => {
    // The core refuses `''` for `content.brand_voice` (1–500 characters) but treats absent as
    // "not set" and keeps its own default.
    await saveStoreSettingsAction(STORE, 'content', { 'content.brand_voice': '  ' }, LOADED, false);
    const sent = sentSettings() as { content: Record<string, unknown> };
    expect('brand_voice' in sent.content).toBe(false);
  });

  it('writes nothing when nothing changed', async () => {
    const result = await saveStoreSettingsAction(
      STORE,
      'tax',
      { 'tax.provider': 'table', 'tax.shipping_taxable': true },
      LOADED,
      false,
    );
    expect(result.status).toBe('success');
    expect(api.updateStore).not.toHaveBeenCalled();
  });
});

describe('the guards', () => {
  it('refuses a principal below store_admin before reading anything', async () => {
    principalOf.current = 'support';
    const result = await saveStoreSettingsAction(
      STORE,
      'tax',
      { 'tax.shipping_taxable': false },
      LOADED,
      false,
    );
    expect(result.status).toBe('error');
    expect(api.getStore).not.toHaveBeenCalled();
    expect(api.updateStore).not.toHaveBeenCalled();
  });

  it('refuses a stale page rather than undoing someone else’s edit', async () => {
    api.getStore.mockResolvedValue(ok(store({ updated_at: '2026-11-25T10:30:00.000Z' })));
    const result = await saveStoreSettingsAction(
      STORE,
      'tax',
      { 'tax.shipping_taxable': false },
      LOADED,
      false,
    );
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.formError).toMatch(/Reload the page/);
    expect(api.updateStore).not.toHaveBeenCalled();
  });

  it.each([
    ['support_refund_limit_minor', 'refunds', { support_refund_limit_minor: 50_000 }],
    ['tax.prices_include_tax', 'tax', { 'tax.prices_include_tax': true }],
    ['fraud.providers', 'fraud', { 'fraud.providers': [] }],
    ['fraud.radar_highest', 'fraud', { 'fraud.radar_highest': 'review' }],
  ] as const)('refuses an unconfirmed change to %s', async (_path, card, values) => {
    const result = await saveStoreSettingsAction(STORE, card, values, LOADED, false);
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.formError).toMatch(/has to be confirmed/);
    expect(api.updateStore).not.toHaveBeenCalled();
  });

  it('saves the same change once it is confirmed', async () => {
    const result = await saveStoreSettingsAction(
      STORE,
      'refunds',
      { support_refund_limit_minor: 50_000 },
      LOADED,
      true,
    );
    expect(result.status).toBe('success');
    expect(sentSettings()['support_refund_limit_minor']).toBe(50_000);
  });

  it('needs no confirmation for a change outside the consequential set', async () => {
    const result = await saveStoreSettingsAction(
      STORE,
      'content',
      { 'content.audience': 'Trade buyers' },
      LOADED,
      false,
    );
    expect(result.status).toBe('success');
  });

  it('rejects a value the core would refuse, naming the field', async () => {
    const result = await saveStoreSettingsAction(
      STORE,
      'fraud',
      { 'fraud.velocity.max_orders': 0, 'fraud.country_mismatch': 'whatever' },
      LOADED,
      true,
    );
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(Object.keys(result.fieldErrors ?? {})).toEqual([
        'fraud.velocity.max_orders',
        'fraud.country_mismatch',
      ]);
    }
    expect(api.updateStore).not.toHaveBeenCalled();
  });

  it('says the core’s 422 in words, naming each offending path', async () => {
    api.updateStore.mockResolvedValue({
      ok: false as const,
      status: 422,
      error: {
        code: 'validation_error',
        message: 'invalid store settings',
        details: { settings: { 'tax.prices_include_tax': 'boolean' } },
      },
    });
    const result = await saveStoreSettingsAction(
      STORE,
      'tax',
      { 'tax.prices_include_tax': true },
      LOADED,
      true,
    );
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.formError).toMatch(/tax.prices_include_tax must be boolean/);
      expect(result.formError).toMatch(/Nothing was saved/);
    }
  });

  it('refuses an unknown card', async () => {
    const result = await saveStoreSettingsAction(
      STORE,
      'nonsense' as never,
      { 'tax.provider': 'stripe' },
      LOADED,
      true,
    );
    expect(result.status).toBe('error');
    expect(api.getStore).not.toHaveBeenCalled();
  });
});
