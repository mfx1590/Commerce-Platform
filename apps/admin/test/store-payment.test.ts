/**
 * Store › Settings › Payment (#825): "Pay on invoice" is a read-modify-write of `settings` (the core
 * REPLACES the object on PATCH), so every other key must survive and the derived `payment.methods` is
 * never sent; below store_admin it is refused before the API; a page older than the store is refused
 * (concurrent edits); the core's 422 `details.settings` is said in words.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrincipalKey } from './fixtures/principals';
import { SEED } from './fixtures/principals';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const principalOf = vi.hoisted(() => ({ current: 'storeAdmin' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals[principalOf.current as PrincipalKey],
  }),
}));

const api = vi.hoisted(() => ({ getStore: vi.fn(), updateStore: vi.fn() }));
vi.mock('@/lib/api/admin', () => api);

const { updatePaymentSettingsAction } = await import('@/app/actions/store-payment');
const { paymentSettingsFrom, withInvoiceAllowed, describeSettingsError } =
  await import('@/lib/settings');

const STORE = SEED.stores.brandA;
const LOADED = '2026-11-12T14:00:00Z';
/** What other modules keep in `settings` (apps/core/src/modules/registry/README.md). */
const otherSettings = {
  support_refund_limit_minor: 5000,
  tax: { provider: 'table', prices_include_tax: true },
  fraud: { providers: ['rules'], velocity: { max_orders: 5, window_minutes: 60 } },
  shipping: { provider: 'manual', services: ['standard'] },
  content: { brand_voice: 'Calm and exact.' },
  payment: { some_future_key: 'kept' },
};
const store = (settings: unknown, updatedAt = LOADED) => ({
  id: STORE,
  code: 'brand-a',
  settings,
  updated_at: updatedAt,
});
const ok = (data: unknown) => ({ ok: true as const, status: 200, data });

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'storeAdmin';
  api.getStore.mockResolvedValue(ok(store(otherSettings)));
  api.updateStore.mockImplementation(async (_id: string, body: { settings: unknown }) =>
    ok(store(body.settings, '2026-11-12T14:05:00Z')),
  );
});

describe('the settings merge (pure)', () => {
  it('reads invoice_allowed safely: only true is on', () => {
    expect(paymentSettingsFrom({ payment: { invoice_allowed: true } })).toEqual({
      invoice_allowed: true,
    });
    for (const settings of [
      undefined,
      null,
      {},
      { payment: null },
      { payment: { invoice_allowed: 'yes' } },
    ]) {
      expect(paymentSettingsFrom(settings).invoice_allowed).toBe(false);
    }
  });

  it('keeps every other key, deep, and changes only payment.invoice_allowed', () => {
    const next = withInvoiceAllowed(otherSettings, true);
    expect(next).toEqual({
      ...otherSettings,
      payment: { some_future_key: 'kept', invoice_allowed: true },
    });
    // The input is not mutated (the page's copy and the re-read stay what they were).
    expect(otherSettings.payment).toEqual({ some_future_key: 'kept' });
  });

  it('never writes the derived payment.methods (the core refuses it)', () => {
    const next = withInvoiceAllowed(
      { payment: { methods: ['card'], invoice_allowed: false } },
      true,
    );
    expect(next).toEqual({ payment: { invoice_allowed: true } });
  });

  it('says the core’s 422 settings paths in words', () => {
    expect(
      describeSettingsError({
        status: 422,
        error: {
          code: 'validation_error',
          message: 'invalid store settings',
          details: {
            settings: { 'payment.invoice_allowed': 'boolean', 'tax.provider': 'table | stripe' },
          },
        },
      }),
    ).toBe(
      "The store's settings were refused: payment.invoice_allowed must be boolean; tax.provider must be table | stripe. Nothing was saved.",
    );
  });
});

describe('updatePaymentSettingsAction', () => {
  it.each(['storeStaff', 'finance', 'analyst', 'support'] as const)(
    '%s is refused before the API',
    async (role) => {
      principalOf.current = role;
      expect(
        await updatePaymentSettingsAction(STORE, {
          invoice_allowed: true,
          loaded_updated_at: LOADED,
        }),
      ).toMatchObject({ status: 'error', refusal: { status: 403 } });
      expect(api.getStore).not.toHaveBeenCalled();
      expect(api.updateStore).not.toHaveBeenCalled();
    },
  );

  it('re-reads the store and sends the whole settings back with invoice on — other keys survive', async () => {
    const result = await updatePaymentSettingsAction(STORE, {
      invoice_allowed: true,
      loaded_updated_at: LOADED,
    });
    expect(api.getStore).toHaveBeenCalledWith(STORE);
    expect(api.updateStore).toHaveBeenCalledWith(STORE, {
      settings: { ...otherSettings, payment: { some_future_key: 'kept', invoice_allowed: true } },
    });
    // Only `settings` is sent: no name, status or defaults ride along.
    expect(Object.keys(api.updateStore.mock.calls[0]?.[1] ?? {})).toEqual(['settings']);
    expect(result).toEqual({
      status: 'success',
      data: { invoice_allowed: true, updated_at: '2026-11-12T14:05:00Z' },
    });
  });

  it('merges into what the core has NOW, not what the page loaded', async () => {
    // Someone added a fraud rule after the page rendered but before this re-read; same updated_at
    // is impossible then, so this pins the merge source: the re-read, not the browser.
    api.getStore.mockResolvedValue(
      ok(store({ ...otherSettings, fraud: { country_mismatch: 'review' } })),
    );
    await updatePaymentSettingsAction(STORE, { invoice_allowed: true, loaded_updated_at: LOADED });
    expect(api.updateStore.mock.calls[0]?.[1]).toMatchObject({
      settings: { fraud: { country_mismatch: 'review' } },
    });
  });

  it('a store changed since the page was opened is refused, and nothing is written', async () => {
    api.getStore.mockResolvedValue(ok(store(otherSettings, '2026-11-12T14:03:00Z')));
    const result = await updatePaymentSettingsAction(STORE, {
      invoice_allowed: true,
      loaded_updated_at: LOADED,
    });
    expect(result).toMatchObject({
      status: 'error',
      formError: expect.stringContaining('changed since this page was opened'),
    });
    expect(api.updateStore).not.toHaveBeenCalled();
  });

  it('turning invoice OFF sends false and still keeps every other key (#833 review)', async () => {
    api.getStore.mockResolvedValue(
      ok(store({ ...otherSettings, payment: { some_future_key: 'kept', invoice_allowed: true } })),
    );
    const result = await updatePaymentSettingsAction(STORE, {
      invoice_allowed: false,
      loaded_updated_at: LOADED,
    });
    expect(api.updateStore).toHaveBeenCalledWith(STORE, {
      settings: { ...otherSettings, payment: { some_future_key: 'kept', invoice_allowed: false } },
    });
    expect(result).toMatchObject({ status: 'success', data: { invoice_allowed: false } });
  });

  it('no change: no write', async () => {
    api.getStore.mockResolvedValue(
      ok(store({ ...otherSettings, payment: { invoice_allowed: true } })),
    );
    const result = await updatePaymentSettingsAction(STORE, {
      invoice_allowed: true,
      loaded_updated_at: LOADED,
    });
    expect(result).toMatchObject({ status: 'success', data: { invoice_allowed: true } });
    expect(api.updateStore).not.toHaveBeenCalled();
  });

  it('the core’s 422 is said in words', async () => {
    api.updateStore.mockResolvedValue({
      ok: false,
      status: 422,
      error: {
        code: 'validation_error',
        message: 'invalid store settings',
        details: { settings: { 'tax.provider': 'table | stripe' } },
      },
    });
    const result = await updatePaymentSettingsAction(STORE, {
      invoice_allowed: true,
      loaded_updated_at: LOADED,
    });
    expect(result).toMatchObject({
      status: 'error',
      formError:
        "The store's settings were refused: tax.provider must be table | stripe. Nothing was saved.",
    });
  });

  it('a failed re-read writes nothing', async () => {
    api.getStore.mockResolvedValue({
      ok: false,
      status: 503,
      error: { code: 'unavailable', message: 'core unavailable' },
    });
    expect(
      (
        await updatePaymentSettingsAction(STORE, {
          invoice_allowed: true,
          loaded_updated_at: LOADED,
        })
      ).status,
    ).toBe('error');
    expect(api.updateStore).not.toHaveBeenCalled();
  });

  it('a malformed body or store id never reaches the API', async () => {
    expect(
      (
        await updatePaymentSettingsAction(STORE, {
          invoice_allowed: 'yes' as unknown as boolean,
          loaded_updated_at: LOADED,
        })
      ).status,
    ).toBe('error');
    expect(
      (await updatePaymentSettingsAction('x', { invoice_allowed: true, loaded_updated_at: LOADED }))
        .status,
    ).toBe('error');
    expect(api.getStore).not.toHaveBeenCalled();
  });
});
