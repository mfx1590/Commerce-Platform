/**
 * AI copy drafts (#608, Admin API 0.4.26): the permission rows are the yaml's; the actions refuse
 * below store_staff before the API; every documented refusal is said in words (Retry-After kept);
 * the save sends a PARTIAL updateProduct body with only the accepted fields.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrincipalKey } from './fixtures/principals';
import { SEED } from './fixtures/principals';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const principalOf = vi.hoisted(() => ({ current: 'storeStaff' as string }));
vi.mock('@/lib/principal', () => ({
  loadPrincipal: async () => ({
    ok: true,
    status: 200,
    data: (await import('./fixtures/principals')).principals[principalOf.current as PrincipalKey],
  }),
}));

const api = vi.hoisted(() => ({ draftProductCopy: vi.fn(), updateProduct: vi.fn() }));
vi.mock('@/lib/api/admin', () => api);

const actions = await import('@/app/actions/copy-drafts');
const lib = await import('@/lib/copy-drafts');
const { parseRetryAfter } = await import('@/lib/api/admin-client');

const STORE = SEED.stores.brandA;
const PRODUCT = '50000000-0000-4000-8000-000000000001';
const draft = {
  product_id: PRODUCT,
  locale: 'en-GB',
  fields: ['description', 'bullets'],
  draft: { description: 'Pure linen.', bullets: ['100% linen', '50 x 70 cm'] },
  brand_voice_source: 'settings',
  model: 'claude-sonnet-5-5',
  template: { id: 'product-copy-draft', version: 2 },
  created_at: '2026-11-01T09:00:00Z',
};

const ok = (data: unknown, status = 200) => ({ ok: true as const, status, data });
const fail = (
  status: number,
  code: string,
  message: string,
  details?: unknown,
  retry?: number,
) => ({
  ok: false as const,
  status,
  error: { code, message, ...(details === undefined ? {} : { details }) },
  ...(retry === undefined ? {} : { retryAfterSeconds: retry }),
});

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'storeStaff';
  api.draftProductCopy.mockResolvedValue(ok(draft));
  api.updateProduct.mockResolvedValue(ok({ id: PRODUCT }));
});

describe('the permission rows are the x-permission admin-api.yaml carries', () => {
  const spec = readFileSync(
    resolve(process.cwd(), '../../packages/contracts/openapi/admin-api.yaml'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  it.each(Object.entries(lib.COPY_DRAFT_PERMISSIONS))('%s', (operation, { relation }) => {
    const at = spec.indexOf(`operationId: ${operation}\n`);
    expect(at, operation).toBeGreaterThan(-1);
    const permission = /x-permission: \{ relation: (\w+), object: '([^']+)' \}/.exec(
      spec.slice(at, at + 2500),
    );
    expect(permission?.[1]).toBe(relation);
    expect(permission?.[2]).toBe('store:{storeId}');
  });
});

describe('draftProductCopyAction', () => {
  it('store_staff and above reach the API with the locale and de-duplicated fields', async () => {
    for (const role of ['storeStaff', 'storeAdmin', 'owner'] as const) {
      principalOf.current = role;
      expect(
        await actions.draftProductCopyAction(STORE, PRODUCT, {
          locale: 'en-GB',
          fields: ['description', 'bullets', 'description'],
        }),
      ).toEqual({ status: 'success', draft });
    }
    expect(api.draftProductCopy).toHaveBeenLastCalledWith(STORE, PRODUCT, {
      locale: 'en-GB',
      fields: ['description', 'bullets'],
    });
  });

  it.each(['finance', 'operations', 'analyst', 'support'] as const)(
    '%s (viewer only on the store) is refused before the API',
    async (role) => {
      principalOf.current = role;
      expect(
        await actions.draftProductCopyAction(STORE, PRODUCT, {
          locale: 'en-GB',
          fields: ['title'],
        }),
      ).toMatchObject({
        status: 'refused',
        refusal: { status: 403, error: { details: { relation: 'store_staff' } } },
      });
      expect(api.draftProductCopy).not.toHaveBeenCalled();
    },
  );

  it('no fields, a bad locale or a non-uuid product never reach the API', async () => {
    for (const values of [
      { locale: 'en-GB', fields: [] },
      { locale: 'x', fields: ['title'] },
      { locale: 'en-GB', fields: ['price'] },
    ]) {
      expect((await actions.draftProductCopyAction(STORE, PRODUCT, values)).status).toBe('error');
    }
    expect(
      (await actions.draftProductCopyAction(STORE, 'nope', { locale: 'en-GB', fields: ['title'] }))
        .status,
    ).toBe('error');
    expect(api.draftProductCopy).not.toHaveBeenCalled();
  });

  const refusals: Array<
    [
      string,
      ReturnType<typeof fail>,
      RegExp,
      Partial<{ retry: boolean; retryAfterSeconds: number }>,
    ]
  > = [
    ['ai_disabled', fail(503, 'ai_disabled', 'AI is disabled'), /switched off/, { retry: false }],
    [
      'ai_budget_exceeded',
      fail(429, 'ai_budget_exceeded', 'budget', {
        used_tokens: 500000,
        limit_tokens: 500000,
        resets_at: '2026-12-01T00:00:00Z',
      }),
      /500,000 of 500,000 tokens used\); it resets on 2026-12-01 00:00 UTC\./,
      { retry: false },
    ],
    [
      'ai_rate_limited',
      fail(429, 'ai_rate_limited', 'slow down', { limit_per_minute: 10 }, 30),
      /Wait 30 s and try again\./,
      { retry: true, retryAfterSeconds: 30 },
    ],
    [
      'ai_refused',
      fail(422, 'ai_refused', 'refused', { category: 'policy' }),
      /refused the request \(policy\)\. Reword the product's facts/,
      { retry: true },
    ],
    [
      'ai_unavailable',
      fail(502, 'ai_unavailable', 'x', { error_class: 'timeout' }),
      /did not answer|Try again/,
      { retry: true },
    ],
    [
      'ai_invalid_draft',
      fail(502, 'ai_invalid_draft', 'x'),
      /did not have the requested fields/,
      { retry: true },
    ],
    ['unavailable', fail(503, 'unavailable', 'x'), /Nothing was sent to the AI/, { retry: true }],
    ['404', fail(404, 'not_found', 'not found'), /no longer exists/, { retry: false }],
    [
      '400',
      fail(400, 'validation_error', 'locale is not enabled'),
      /locale is not enabled — check the locale/,
      { retry: false },
    ],
  ];
  it.each(refusals)('%s is said in words', async (_name, failure, words, extra) => {
    api.draftProductCopy.mockResolvedValue(failure);
    const result = await actions.draftProductCopyAction(STORE, PRODUCT, {
      locale: 'en-GB',
      fields: ['description'],
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(`${result.error.title}. ${result.error.message}`).toMatch(words);
    expect(result.error).toMatchObject(extra);
  });

  it('a server 403 is the refusal panel', async () => {
    api.draftProductCopy.mockResolvedValue(fail(403, 'forbidden', 'requires store_staff'));
    expect(
      await actions.draftProductCopyAction(STORE, PRODUCT, { locale: 'en-GB', fields: ['title'] }),
    ).toMatchObject({ status: 'refused', refusal: { status: 403 } });
  });
});

describe('saveProductCopyAction', () => {
  it('sends only the patch it is given', async () => {
    await actions.saveProductCopyAction(STORE, PRODUCT, { description: 'New.' });
    expect(api.updateProduct).toHaveBeenCalledWith(STORE, PRODUCT, { description: 'New.' });
  });

  it('refuses below store_staff before the API', async () => {
    principalOf.current = 'finance';
    expect(await actions.saveProductCopyAction(STORE, PRODUCT, { title: 'x' })).toMatchObject({
      status: 'error',
      refusal: { status: 403 },
    });
    expect(api.updateProduct).not.toHaveBeenCalled();
  });

  it.each([
    [{}, /at least one field/],
    [{ title: ' ' }, /title cannot be empty/],
    [{ seo: { title: 'x'.repeat(71), description: '' } }, /at most 70/],
    [{ seo: { title: '', description: 'x'.repeat(161) } }, /at most 160/],
  ])('refuses %j before the API', async (patch, words) => {
    const result = await actions.saveProductCopyAction(STORE, PRODUCT, patch);
    expect(result.status === 'error' && result.formError).toMatch(words);
    expect(api.updateProduct).not.toHaveBeenCalled();
  });
});

describe('the save mapping', () => {
  const product = {
    title: 'Tea towel',
    description: 'Old text.',
    seo: { canonical: '/x', title: 'Old' },
  };
  const current = lib.currentCopy(product);

  it('the current copy reads seo strings and has no bullets', () => {
    expect(current).toEqual({
      title: 'Tea towel',
      description: 'Old text.',
      bullets: [],
      seo: { title: 'Old', description: '' },
    });
  });

  it('bullets join the edited description as a list; seo keeps its other keys', () => {
    const edited = lib.editableDraft(
      { description: 'New text.', bullets: ['a', ' ', 'b'], seo: { title: 'T', description: 'D' } },
      current,
    );
    expect(
      lib.draftToProductPatch(product, new Set(['description', 'bullets', 'seo']), edited),
    ).toEqual({
      description: 'New text.\n\n- a\n- b',
      seo: { canonical: '/x', title: 'T', description: 'D' },
    });
  });

  it('bullets alone are appended to the CURRENT description', () => {
    const edited = lib.editableDraft({ bullets: ['a'] }, current);
    expect(lib.draftToProductPatch(product, new Set(['bullets']), edited)).toEqual({
      description: 'Old text.\n\n- a',
    });
  });

  it('a field not accepted is not in the patch', () => {
    const edited = lib.editableDraft({ title: 'New', description: 'New text.' }, current);
    expect(lib.draftToProductPatch(product, new Set(['title']), edited)).toEqual({ title: 'New' });
  });

  it('the line diff marks removed and added lines and keeps the same ones', () => {
    expect(lib.lineDiff('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
    expect(lib.lineDiff('', 'new')).toEqual([{ kind: 'added', text: 'new' }]);
  });
});

describe('Retry-After', () => {
  it.each([
    ['30', 30],
    [' 5 ', 5],
    ['0', undefined],
    ['soon', undefined],
    [null, undefined],
  ])('%j → %j', (value, seconds) => {
    expect(parseRetryAfter(value)).toBe(seconds);
  });

  it('an HTTP date becomes seconds from now', () => {
    const now = Date.parse('2026-11-01T09:00:00Z');
    expect(parseRetryAfter('Sun, 01 Nov 2026 09:00:20 GMT', now)).toBe(20);
  });
});

describe('a re-drafted bullet list replaces the old one (#675 review)', () => {
  it('stripTrailingList removes only a trailing "- " list', () => {
    expect(lib.stripTrailingList('Text.\n\n- a\n- b')).toBe('Text.');
    expect(lib.stripTrailingList('- not a tail\nText.')).toBe('- not a tail\nText.');
    expect(lib.stripTrailingList('Text.')).toBe('Text.');
  });

  it('saving bullets twice never doubles the list', () => {
    const once = lib.withBullets('Text.', ['a', 'b']);
    expect(lib.withBullets(once, ['c'])).toBe('Text.\n\n- c');
  });
});
