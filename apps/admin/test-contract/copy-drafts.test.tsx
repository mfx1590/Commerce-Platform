/**
 * AI copy drafts (#608) against the spec's own examples (Admin API 0.4.26): `draftProductCopy`'s
 * 200 (the ProductCopyDraft example), and the documented refusals — 422 `ai_refused`, 429
 * (`Retry-After` read into `retryAfterSeconds` when sent), 502, 503 — each said in words. Prism's
 * `/admin/me` is the store_admin example on brand-a, which implies store_staff.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SEED_STORE_ID, preferring, startPrism, type PrismHandle } from './prism';

// 4211–4221 are taken by the other suites.
const BASE = 'http://127.0.0.1:4222';
let prism: PrismHandle | undefined;
process.env['ADMIN_API_URL'] = BASE;
process.env['MOCK_ADMIN_API_URL'] = BASE;

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/current-session', () => ({
  getSession: async () => ({ accessToken: 'contract-test-token' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const api = await import('@/lib/api/admin');
const { adminRequest } = await import('@/lib/api/admin-client');
const actions = await import('@/app/actions/copy-drafts');
const { describeDraftError } = await import('@/lib/copy-drafts');

const PRODUCT = '50000000-0000-4000-8000-000000000001';
const body = { locale: 'en-GB', fields: ['description', 'bullets'] as const };

const forced = (code: number) =>
  adminRequest<'draftProductCopy'>({
    baseUrl: BASE,
    path: `/admin/stores/${SEED_STORE_ID}/products/${PRODUCT}/copy-drafts`,
    method: 'POST',
    accessToken: 'contract-test-token',
    headers: preferring(code),
    body,
  });

beforeAll(async () => {
  prism = await startPrism(BASE);
}, 60_000);

afterAll(() => prism?.stop());

describe('draftProductCopy reaches the path the spec documents', () => {
  it('answers a ProductCopyDraft with the model, the template and only drafted fields', async () => {
    const result = await api.draftProductCopy(SEED_STORE_ID, PRODUCT, {
      locale: body.locale,
      fields: [...body.fields],
    });
    if (!result.ok) throw new Error(`draftProductCopy failed: ${result.status}`);
    expect(result.data).toMatchObject({
      product_id: expect.any(String),
      locale: expect.any(String),
      fields: expect.any(Array),
      brand_voice_source: expect.stringMatching(/^(settings|default)$/),
      model: expect.any(String),
      template: { id: expect.any(String), version: expect.any(Number) },
    });
    for (const key of Object.keys(result.data.draft)) {
      expect(result.data.fields).toContain(key);
    }
  });

  it('the action answers the same draft for store_admin on brand-a (store_staff implied)', async () => {
    expect(
      await actions.draftProductCopyAction(SEED_STORE_ID, PRODUCT, {
        locale: 'en-GB',
        fields: ['description'],
      }),
    ).toMatchObject({ status: 'success', draft: { model: expect.any(String) } });
  });
});

describe('the documented refusals are said in words, never a crash', () => {
  it.each([422, 429, 502, 503])('%i', async (code) => {
    const result = await forced(code);
    if (result.ok) throw new Error(`expected ${code}`);
    expect(result.status).toBe(code);
    const refusal = describeDraftError(result);
    expect(refusal.title).toEqual(expect.any(String));
    expect(refusal.message).toEqual(expect.any(String));
    if (result.retryAfterSeconds !== undefined) {
      expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
  });
});
