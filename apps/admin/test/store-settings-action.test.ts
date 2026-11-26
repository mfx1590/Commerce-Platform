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
      // Since the #968 review this path is confirmed, so the list has to name it.
      [{ path: 'tax.shipping_taxable', to: false }],
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
      [{ path: 'tax.shipping_taxable', to: false }],
    );
    const sent = sentSettings();
    expect(sent['support_refund_limit_minor']).toBe(5000);
    expect(sent['fraud']).toEqual(SETTINGS.fraud);
    expect(sent['payment']).toEqual({ invoice_allowed: true });
  });

  it('clears a text setting by deleting the path, not by storing an empty string', async () => {
    // The core refuses `''` for `content.brand_voice` (1–500 characters) but treats absent as
    // "not set" and keeps its own default.
    await saveStoreSettingsAction(STORE, 'content', { 'content.brand_voice': '  ' }, LOADED, []);
    const sent = sentSettings() as { content: Record<string, unknown> };
    expect('brand_voice' in sent.content).toBe(false);
  });

  it('clears a NUMBER by deleting the path, which is the only way to say "no ceiling"', async () => {
    // `z.number()` refuses `undefined`, so an earlier cut turned "no ceiling" into a field error
    // and the one state the core reads as "no limit" could not be saved at all. The form test
    // could not catch it: there the action is a mock.
    const result = await saveStoreSettingsAction(
      STORE,
      'refunds',
      { support_refund_limit_minor: undefined },
      LOADED,
      [{ path: 'support_refund_limit_minor', to: undefined }],
    );
    expect(result.status).toBe('success');
    expect('support_refund_limit_minor' in sentSettings()).toBe(false);
  });

  it('clears an enum and an array the same way, without storing a falsy value', async () => {
    const result = await saveStoreSettingsAction(
      STORE,
      'fraud',
      { 'fraud.providers': undefined, 'fraud.country_mismatch': '' },
      LOADED,
      [{ path: 'fraud.providers', to: undefined }],
    );
    expect(result.status).toBe('success');
    const fraud = sentSettings()['fraud'] as Record<string, unknown>;
    // Not `[]`: the core reads an absent `providers` as "run both checks", and `[]` as "run none".
    expect('providers' in fraud).toBe(false);
    expect('country_mismatch' in fraud).toBe(false);
  });

  it('writes nothing when nothing changed', async () => {
    const result = await saveStoreSettingsAction(
      STORE,
      'tax',
      { 'tax.provider': 'table', 'tax.shipping_taxable': true },
      LOADED,
      [],
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
      [],
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
      [],
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
    const result = await saveStoreSettingsAction(STORE, card, values, LOADED, []);
    expect(result.status).toBe('error');
    if (result.status === 'error')
      expect(result.formError).toMatch(/not the one that was confirmed/);
    expect(api.updateStore).not.toHaveBeenCalled();
  });

  it('refuses a confirmation for a DIFFERENT value than the one being saved (#968 review)', async () => {
    // The dialog said €500; the request carries €5,000. A boolean could not tell the difference.
    const result = await saveStoreSettingsAction(
      STORE,
      'refunds',
      { support_refund_limit_minor: 500_000 },
      LOADED,
      [{ path: 'support_refund_limit_minor', to: 50_000 }],
    );
    expect(result.status).toBe('error');
    expect(api.updateStore).not.toHaveBeenCalled();
  });

  it('refuses when one of two consequential changes was never confirmed', async () => {
    const result = await saveStoreSettingsAction(
      STORE,
      'tax',
      { 'tax.prices_include_tax': true, 'tax.shipping_taxable': false },
      LOADED,
      [{ path: 'tax.prices_include_tax', to: true }],
    );
    expect(result.status).toBe('error');
    expect(api.updateStore).not.toHaveBeenCalled();
  });

  it('refuses a confirmation that names a path this save does not change', async () => {
    const result = await saveStoreSettingsAction(
      STORE,
      'tax',
      { 'tax.prices_include_tax': true },
      LOADED,
      [
        { path: 'tax.prices_include_tax', to: true },
        { path: 'tax.shipping_taxable', to: false },
      ],
    );
    expect(result.status).toBe('error');
    expect(api.updateStore).not.toHaveBeenCalled();
  });

  it('accepts both consequential changes when both were confirmed', async () => {
    const result = await saveStoreSettingsAction(
      STORE,
      'tax',
      { 'tax.prices_include_tax': true, 'tax.shipping_taxable': false },
      LOADED,
      [
        // Order does not matter; the comparison sorts by path.
        { path: 'tax.shipping_taxable', to: false },
        { path: 'tax.prices_include_tax', to: true },
      ],
    );
    expect(result.status).toBe('success');
    const sent = sentSettings()['tax'] as Record<string, unknown>;
    expect(sent['prices_include_tax']).toBe(true);
    expect(sent['shipping_taxable']).toBe(false);
  });

  it('saves the same change once it is confirmed', async () => {
    const result = await saveStoreSettingsAction(
      STORE,
      'refunds',
      { support_refund_limit_minor: 50_000 },
      LOADED,
      [{ path: 'support_refund_limit_minor', to: 50_000 }],
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
      [],
    );
    expect(result.status).toBe('success');
  });

  it('rejects a value the core would refuse, naming the field', async () => {
    const result = await saveStoreSettingsAction(
      STORE,
      'fraud',
      { 'fraud.velocity.max_orders': 0, 'fraud.country_mismatch': 'whatever' },
      LOADED,
      [],
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
      [{ path: 'tax.prices_include_tax', to: true }],
    );
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.formError).toMatch(/tax.prices_include_tax must be boolean/);
      expect(result.formError).toMatch(/Nothing was saved/);
    }
  });

  it('refuses a parcel with three of its four numbers (#870 item 7 PR B)', async () => {
    // `parcelOf` in the core returns null unless all four are present and positive, and the whole
    // parcel then falls back to 30x20x10 / 1000g. Writing three would be a silent no-op, so it is
    // refused here rather than stored.
    const result = await saveStoreSettingsAction(
      STORE,
      'shipping',
      {
        'shipping.default_parcel.length_cm': 40,
        'shipping.default_parcel.width_cm': 30,
        'shipping.default_parcel.height_cm': 20,
      },
      LOADED,
      [],
    );
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.formError).toMatch(/all four/);
    expect(api.updateStore).not.toHaveBeenCalled();
  });

  it('allows the one field that COMPLETES a parcel, because only changed fields are sent', async () => {
    api.getStore.mockResolvedValue(
      ok(
        store({
          settings: {
            ...SETTINGS,
            shipping: {
              ...SETTINGS.shipping,
              default_parcel: { length_cm: 40, width_cm: 30, height_cm: 20 },
            },
          },
        }),
      ),
    );
    const result = await saveStoreSettingsAction(
      STORE,
      'shipping',
      { 'shipping.default_parcel.weight_g': 2000 },
      LOADED,
      [],
    );
    expect(result.status).toBe('success');
    const parcel = (sentSettings()['shipping'] as Record<string, unknown>)['default_parcel'];
    expect(parcel).toEqual({ length_cm: 40, width_cm: 30, height_cm: 20, weight_g: 2000 });
  });

  it('clearing the whole parcel is allowed: none is as valid as four', async () => {
    api.getStore.mockResolvedValue(
      ok(
        store({
          settings: {
            ...SETTINGS,
            shipping: {
              ...SETTINGS.shipping,
              default_parcel: { length_cm: 40, width_cm: 30, height_cm: 20, weight_g: 2000 },
            },
          },
        }),
      ),
    );
    const result = await saveStoreSettingsAction(
      STORE,
      'shipping',
      {
        'shipping.default_parcel.length_cm': undefined,
        'shipping.default_parcel.width_cm': undefined,
        'shipping.default_parcel.height_cm': undefined,
        'shipping.default_parcel.weight_g': undefined,
      },
      LOADED,
      [],
    );
    expect(result.status).toBe('success');
    expect((sentSettings()['shipping'] as Record<string, unknown>)['default_parcel']).toEqual({});
  });

  it('refuses a label format the core would silently ignore', async () => {
    const result = await saveStoreSettingsAction(
      STORE,
      'shipping',
      { 'shipping.label_format': 'PDF417' },
      LOADED,
      [],
    );
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(Object.keys(result.fieldErrors ?? {})).toEqual(['shipping.label_format']);
    }
    expect(api.updateStore).not.toHaveBeenCalled();
  });

  it('refuses an empty entry in a list rather than storing a code that matches nothing', async () => {
    const result = await saveStoreSettingsAction(
      STORE,
      'shipping',
      { 'shipping.services': ['ups_ground', '  '] },
      LOADED,
      [],
    );
    expect(result.status).toBe('error');
    expect(api.updateStore).not.toHaveBeenCalled();
  });

  it('refuses a country map key that is not a country', async () => {
    const result = await saveStoreSettingsAction(
      STORE,
      'fulfillment',
      { 'fulfillment.routing.countries': { Netherlands: 'wh-eu' } },
      LOADED,
      [],
    );
    expect(result.status).toBe('error');
    expect(api.updateStore).not.toHaveBeenCalled();
  });

  it('refuses an unknown card', async () => {
    const result = await saveStoreSettingsAction(
      STORE,
      'nonsense' as never,
      { 'tax.provider': 'stripe' },
      LOADED,
      [],
    );
    expect(result.status).toBe('error');
    expect(api.getStore).not.toHaveBeenCalled();
  });
});
