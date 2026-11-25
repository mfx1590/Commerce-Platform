/**
 * Search merchandising rules (#870 wave 1 item 5, PR C; Opus review): what a rule IS at a time,
 * the screen's filters, the checks before a save, and "Publish to search" reported honestly per
 * rule — the API answers with counts only, so each rule is read back: published only when its
 * publish time was stamped by this run, skipped with the reason, otherwise "not confirmed"; and a
 * disagreement with the API's counts is said. Every change is store_admin, refused before the API.
 */
/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MerchandisingRule, RuleDraft } from '@/lib/catalog/merchandising';
import type { PrincipalKey } from './fixtures/principals';

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
const api = vi.hoisted(() => ({
  listMerchandisingRules: vi.fn(),
  createMerchandisingRule: vi.fn(),
  updateMerchandisingRule: vi.fn(),
  deleteMerchandisingRule: vi.fn(),
  publishMerchandisingRules: vi.fn(),
  listCategories: vi.fn(),
  listProducts: vi.fn(),
}));
vi.mock('@/lib/api/admin', () => api);

const m = await import('@/lib/catalog/merchandising');
const actions = await import('@/app/actions/merchandising');

const STORE = '00000000-0000-4000-8000-000000000031';
const CAT = '00000000-0000-4000-8000-000000000201';
const P1 = '00000000-0000-4000-8000-000000000301';
const P2 = '00000000-0000-4000-8000-000000000302';
const NOW = new Date('2026-11-25T12:00:00Z');

let n = 0;
function rule(over: Partial<MerchandisingRule> = {}) {
  n += 1;
  return {
    id: `30000000-0000-4000-8000-00000000050${n % 10}`,
    scope: { type: 'category' as const, category_id: CAT, query: null },
    pins: [],
    boosts: [],
    buries: [],
    enabled: true,
    starts_at: null,
    ends_at: null,
    published_at: '2026-11-20T00:00:00Z',
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...over,
  };
}

const draft = (over: Partial<RuleDraft> = {}) => ({
  scope: { type: 'category' as const, category_id: CAT, query: '' },
  pins: [P1],
  boosts: [{ product_id: P2, weight: 40 }],
  buries: [],
  enabled: true,
  starts_at: null,
  ends_at: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  principalOf.current = 'storeAdmin';
  api.listCategories.mockResolvedValue({
    ok: true,
    status: 200,
    data: { items: [{ id: CAT, name: 'Kitchen' }] },
  });
});

describe('a rule at a time', () => {
  it('live, disabled, scheduled, ended — the same rule the publish applies', () => {
    expect(m.ruleState(rule(), NOW)).toBe('live');
    expect(m.ruleState(rule({ enabled: false }), NOW)).toBe('disabled');
    expect(m.ruleState(rule({ starts_at: '2026-12-01T00:00:00Z' }), NOW)).toBe('scheduled');
    expect(m.ruleState(rule({ ends_at: '2026-11-25T12:00:00Z' }), NOW)).toBe('ended');
    expect(
      m.ruleState(
        rule({ starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-12-01T00:00:00Z' }),
        NOW,
      ),
    ).toBe('live');
  });

  it('never published / changed since the last publish', () => {
    expect(m.unpublishedChange(rule({ published_at: null }))).toBe('never');
    expect(m.unpublishedChange(rule({ updated_at: '2026-11-21T00:00:00Z' }))).toBe('changed');
    expect(m.unpublishedChange(rule())).toBeNull();
  });

  it('filters: scope, state, category, query text — over the full list', () => {
    const q = rule({ scope: { type: 'query', category_id: null, query: 'Linen Towel' } });
    const off = rule({ enabled: false });
    const all = [rule(), q, off];
    expect(m.filterRules(all, { scope: 'query' }, NOW)).toEqual([q]);
    expect(m.filterRules(all, { state: 'disabled' }, NOW)).toEqual([off]);
    expect(m.filterRules(all, { category_id: CAT }, NOW)).toHaveLength(2);
    expect(m.filterRules(all, { q: 'linen' }, NOW)).toEqual([q]);
    expect(m.filterRules(all, {}, NOW)).toHaveLength(3);
  });
});

describe('before a save', () => {
  it('a valid draft has no problems', () => {
    expect(m.ruleProblems(draft())).toEqual({});
  });

  it.each([
    ['no category', draft({ scope: { type: 'category', category_id: '', query: '' } }), 'scope'],
    ['an empty query', draft({ scope: { type: 'query', category_id: '', query: '  ' } }), 'scope'],
    ['a weight of 0', draft({ boosts: [{ product_id: P2, weight: 0 }] }), 'boosts'],
    ['a weight of 101', draft({ boosts: [{ product_id: P2, weight: 101 }] }), 'boosts'],
    ['a fractional weight', draft({ boosts: [{ product_id: P2, weight: 1.5 }] }), 'boosts'],
    ['a product pinned and buried', draft({ buries: [P1] }), 'form'],
    [
      '51 pins',
      draft({
        pins: Array.from(
          { length: 51 },
          (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        ),
      }),
      'pins',
    ],
    [
      'an end before the start',
      draft({ starts_at: '2026-12-02T10:00:00Z', ends_at: '2026-12-01T10:00:00Z' }),
      'ends_at',
    ],
  ])('%s', (_, value, field) => {
    expect(m.ruleProblems(value)).toHaveProperty(field);
  });

  it('the input sends the scope; the window goes as the instants it was given, byte for byte', () => {
    const input = m.draftToInput(
      draft({ starts_at: '2026-12-01T09:00:30Z', ends_at: '2026-12-31T23:00:00+09:00' }),
    );
    expect(input.scope).toEqual({ type: 'category', category_id: CAT });
    expect(input.starts_at).toBe('2026-12-01T09:00:30Z');
    expect(input.ends_at).toBe('2026-12-31T23:00:00+09:00');
    expect(m.draftToPatch(draft())).not.toHaveProperty('scope');
  });

  it('#963 review: a time without its zone is refused, here and by the action before the API', async () => {
    for (const zoneless of [
      '2026-12-01T10:00',
      '2026-12-01T10:00:00',
      '2026-12-01 10:00Z',
      'tomorrow',
    ]) {
      expect(m.ruleProblems(draft({ starts_at: zoneless })), zoneless).toHaveProperty('starts_at');
      expect(m.ruleProblems(draft({ ends_at: zoneless })), zoneless).toHaveProperty('ends_at');
    }
    expect(m.ruleProblems(draft({ starts_at: '2026-12-01T10:00:00+05:30' }))).toEqual({});
    expect(
      await actions.createRuleAction(STORE, draft({ starts_at: '2026-12-01T10:00' })),
    ).toMatchObject({
      status: 'error',
      fieldErrors: { starts_at: 'Not a date and time with its time zone.' },
    });
    expect(
      await actions.updateRuleAction(
        STORE,
        '30000000-0000-4000-8000-000000000501',
        draft({ ends_at: '2026-12-01T10:00' }),
      ),
    ).toMatchObject({
      status: 'error',
      fieldErrors: { ends_at: 'Not a date and time with its time zone.' },
    });
    expect(api.createMerchandisingRule).not.toHaveBeenCalled();
    expect(api.updateMerchandisingRule).not.toHaveBeenCalled();
  });

  it('end after start compares instants, whatever their offsets', () => {
    // 10:00+02:00 is 08:00Z: an end at 09:00Z is after it, although "09" < "10".
    expect(
      m.ruleProblems(
        draft({ starts_at: '2026-12-01T10:00:00+02:00', ends_at: '2026-12-01T09:00:00Z' }),
      ),
    ).toEqual({});
    expect(
      m.ruleProblems(
        draft({ starts_at: '2026-12-01T10:00:00Z', ends_at: '2026-12-01T11:00:00+02:00' }),
      ),
    ).toHaveProperty('ends_at');
  });
});

describe('"Publish to search", honest per rule', () => {
  const START = new Date('2026-11-25T12:00:00Z');
  it('published only when stamped by this run; skipped with the reason; otherwise not confirmed', () => {
    const stamped = rule({ published_at: '2026-11-25T12:00:01Z' });
    const notStamped = rule({ published_at: '2026-11-20T00:00:00Z' });
    const disabled = rule({ enabled: false });
    const later = rule({ starts_at: '2026-12-01T00:00:00Z' });
    const ended = rule({ ends_at: '2026-11-01T00:00:00Z' });
    const report = m.publishOutcomes(
      { index: 'brand-a_products', published: 2, skipped: 3 },
      [stamped, notStamped, disabled, later, ended],
      START,
    );
    expect(report.rows.map((r) => r.outcome)).toEqual([
      'published',
      'not-confirmed',
      'skipped',
      'skipped',
      'skipped',
    ]);
    expect(report.rows[2]!.why).toBe('Disabled.');
    expect(report.rows[3]!.why).toBe('Not started: starts 2026-12-01 00:00 UTC.');
    expect(report.rows[4]!.why).toBe('Ended 2026-11-01 00:00 UTC.');
    expect(report.rows[0]!.why).toBe('In the index since 2026-11-25 12:00 UTC.');
    // The API said 2 published; only 1 is confirmed: said, never papered over.
    expect(report.mismatch).toContain('counted 2 published and 3 skipped');
    expect(report.mismatch).toContain('show 1 published and 3 skipped');
  });

  it('counts that agree: no mismatch', () => {
    const report = m.publishOutcomes(
      { index: 'i', published: 1, skipped: 1 },
      [rule({ published_at: '2026-11-25T12:00:02Z' }), rule({ enabled: false })],
      START,
    );
    expect(report.mismatch).toBeNull();
  });

  it('the preview counts what a publish now would put in', () => {
    expect(
      m.publishPreview(
        [rule(), rule({ enabled: false }), rule({ ends_at: '2026-11-01T00:00:00Z' })],
        NOW,
      ),
    ).toEqual({ live: 1, skipped: 2 });
  });
});

describe('times are said with their zone', () => {
  it('utcLabel and the CSV: UTC, said, whatever offset the API used', () => {
    expect(m.utcLabel('2026-12-01T09:00:00+09:00')).toBe('2026-12-01 00:00 UTC');
    expect(m.utcLabel(null)).toBe('—');
    const row = m.ruleCsvRow(
      rule({
        starts_at: '2026-12-01T09:00:00+09:00',
        ends_at: null,
        published_at: '2026-11-20T00:00:00Z',
      }),
      { categories: { [CAT]: 'Kitchen' }, products: {} },
      NOW,
    );
    const at = (name: string) =>
      row[m.RULES_CSV_HEADER.indexOf(name as (typeof m.RULES_CSV_HEADER)[number])];
    expect(at('starts_at')).toBe('2026-12-01T00:00:00.000Z');
    expect(at('ends_at')).toBe('');
    expect(at('published_at')).toBe('2026-11-20T00:00:00.000Z');
  });
});

describe('the actions', () => {
  it('store_staff reads but every change is refused before the API', async () => {
    principalOf.current = 'storeStaff';
    for (const result of [
      await actions.createRuleAction(STORE, draft()),
      await actions.updateRuleAction(STORE, '30000000-0000-4000-8000-000000000501', draft()),
      await actions.publishRulesAction(STORE),
      await actions.bulkRulesAction(
        STORE,
        { mode: 'rows', ids: ['30000000-0000-4000-8000-000000000501'] },
        'disable',
      ),
    ]) {
      expect(result).toMatchObject({ status: 'error', refusal: { status: 403 } });
    }
    for (const fn of [
      api.createMerchandisingRule,
      api.updateMerchandisingRule,
      api.publishMerchandisingRules,
      api.listMerchandisingRules,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('an invalid draft is refused before the API; a taken scope is said on the scope', async () => {
    expect(await actions.createRuleAction(STORE, draft({ buries: [P1] }))).toMatchObject({
      status: 'error',
    });
    expect(api.createMerchandisingRule).not.toHaveBeenCalled();
    api.createMerchandisingRule.mockResolvedValue({
      ok: false,
      status: 409,
      error: { code: 'conflict', message: 'exists' },
    });
    expect(await actions.createRuleAction(STORE, draft())).toMatchObject({
      fieldErrors: { scope: 'This scope already has a rule: edit that one instead.' },
    });
  });

  it('publish: no index (409) says nothing was published; no answer (5xx) says it may or may not be', async () => {
    api.publishMerchandisingRules.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: { code: 'conflict', message: 'no search credentials' },
    });
    expect(await actions.publishRulesAction(STORE)).toMatchObject({
      formError: expect.stringContaining('Nothing was published'),
    });
    api.publishMerchandisingRules.mockResolvedValueOnce({
      ok: false,
      status: 502,
      error: { code: 'upstream', message: 'bad gateway' },
    });
    expect(await actions.publishRulesAction(STORE)).toMatchObject({
      formError: expect.stringContaining('may or may not have the rules'),
    });
  });

  it('publish: the rules are read back and reported one by one', async () => {
    const live = rule({ id: '30000000-0000-4000-8000-000000000511' });
    api.publishMerchandisingRules.mockImplementation(async () => {
      live.published_at = new Date().toISOString();
      return {
        ok: true,
        status: 200,
        data: { index: 'brand-a_products', published: 1, skipped: 0 },
      };
    });
    api.listMerchandisingRules.mockImplementation(async () => ({
      ok: true,
      status: 200,
      data: { items: [live] },
    }));
    const result = await actions.publishRulesAction(STORE);
    expect(result).toMatchObject({
      status: 'success',
      data: { mismatch: null, rows: [{ id: live.id, outcome: 'published' }] },
    });
  });

  it('publish: rules not read back → per-rule result unknown, said', async () => {
    api.publishMerchandisingRules.mockResolvedValue({
      ok: true,
      status: 200,
      data: { index: 'i', published: 3, skipped: 0 },
    });
    api.listMerchandisingRules.mockResolvedValue({
      ok: false,
      status: 503,
      error: { code: 'x', message: 'unavailable' },
    });
    expect(await actions.publishRulesAction(STORE)).toMatchObject({
      status: 'success',
      data: { rows: [], mismatch: expect.stringContaining('the result per rule is not known') },
    });
  });

  it('bulk disable: one patch per rule, an already-disabled rule skipped, labelled by scope', async () => {
    const on = rule({ id: '30000000-0000-4000-8000-000000000521' });
    const off = rule({
      id: '30000000-0000-4000-8000-000000000522',
      enabled: false,
      scope: { type: 'query', category_id: null, query: 'towel' },
    });
    api.listMerchandisingRules.mockResolvedValue({
      ok: true,
      status: 200,
      data: { items: [on, off] },
    });
    api.updateMerchandisingRule.mockImplementation(
      async (_s: string, _id: string, body: { enabled: boolean }) => ({
        ok: true,
        status: 200,
        data: { ...on, ...body },
      }),
    );
    const result = await actions.bulkRulesAction(
      STORE,
      { mode: 'all-matching', filters: {}, excluded: [], total: 2 },
      'disable',
    );
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(api.updateMerchandisingRule).toHaveBeenCalledTimes(1);
    expect(api.updateMerchandisingRule).toHaveBeenCalledWith(STORE, on.id, { enabled: false });
    expect(result.data.results.map((r) => [r.label, r.outcome])).toEqual([
      ['Category Kitchen', 'done'],
      ['Search “towel”', 'skipped'],
    ]);
  });

  it('the product picker needs the catalog section and sends the search to listProducts', async () => {
    api.listProducts.mockResolvedValue({
      ok: true,
      status: 200,
      data: { items: [{ id: P1, title: 'Tea towel', status: 'published' }], total: 1 },
    });
    expect(await actions.searchProductsForRuleAction(STORE, ' towel ')).toEqual({
      status: 'success',
      data: [{ id: P1, title: 'Tea towel', status: 'published' }],
    });
    expect(api.listProducts).toHaveBeenCalledWith(STORE, { q: 'towel', limit: 20, page: 1 });
    principalOf.current = 'unassigned';
    expect(await actions.searchProductsForRuleAction(STORE, 'towel')).toMatchObject({
      status: 'error',
    });
  });
});
