/**
 * The Marketing section against the real spec, not a stubbed fetch (#149).
 *
 * Two things this proves that a unit test cannot:
 *
 * 1. **The typed wrappers reach the paths `admin-api.yaml` documents.** Prism answers from the spec, so a
 *    wrong path or a missing parameter is a 404 from the mock rather than a green test.
 * 2. **The rule builder emits a body the contract accepts.** Prism validates request bodies, so posting
 *    `toRules(draft)` as a `SegmentInput` is the end-to-end form of #149's "emits the exact SegmentRules JSON
 *    the contract defines" — with no copy of the grammar living in this app.
 *
 * Prism is spawned here, so `pnpm --filter @platform/admin test:contract` needs nothing running.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SEED_STORE_ID, preferring, startPrism, type PrismHandle } from '../prism';

/** Its own port, set before the modules under test are imported (they resolve the base URL at module scope). */
const BASE = 'http://127.0.0.1:4216';
process.env['ADMIN_API_URL'] = BASE;
process.env['MOCK_ADMIN_API_URL'] = BASE;

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/current-session', () => ({
  getSession: async () => ({ accessToken: 'contract-test' }),
  requireSession: async () => ({ accessToken: 'contract-test' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { adminCall } = await import('@/lib/api/admin');
const { buildPath } = await import('@/lib/api/admin-client');
const storeApi = await import('@/app/(store)/[storeId]/marketing/_api');
const hqApi = await import('@/app/(hq)/marketing/_api');
const { toRules, SEGMENT_FIELDS } =
  await import('@/app/(store)/[storeId]/marketing/segments/_rules');

let prism: PrismHandle;

const WINDOW = { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' };
/** Any uuid: Prism answers from the spec's examples, not from a database. */
const ID = '70000000-0000-4000-8000-000000000701';

beforeAll(async () => {
  prism = await startPrism(BASE);
}, 60_000);

afterAll(() => {
  prism?.stop();
});

describe('every screen reaches the path the contract documents', () => {
  it('Overview: both reports', async () => {
    const attribution = await storeApi.getAttributionReport(SEED_STORE_ID, {
      ...WINDOW,
      touch: 'last',
    });
    expect(attribution.ok, JSON.stringify(attribution)).toBe(true);
    if (attribution.ok) {
      // The shape the page renders — totals plus a row per source/medium/campaign.
      expect(attribution.data).toHaveProperty('totals.orders_count');
      expect(Array.isArray(attribution.data.items)).toBe(true);
    }

    const promotions = await storeApi.getPromotionReport(SEED_STORE_ID, WINDOW);
    expect(promotions.ok, JSON.stringify(promotions)).toBe(true);
  });

  it('Campaigns: list, read, and both transitions', async () => {
    const list = await storeApi.listCampaigns(SEED_STORE_ID, { page: 1, limit: 20 });
    expect(list.ok, JSON.stringify(list)).toBe(true);
    if (list.ok) expect(Array.isArray(list.data.items)).toBe(true);

    expect((await storeApi.getCampaign(SEED_STORE_ID, ID)).ok).toBe(true);
    expect((await storeApi.launchCampaign(SEED_STORE_ID, ID)).ok).toBe(true);
    expect((await storeApi.endCampaign(SEED_STORE_ID, ID)).ok).toBe(true);
  });

  it('Segments: list, read, preview and materialize', async () => {
    expect((await storeApi.listSegments(SEED_STORE_ID, { page: 1, limit: 20 })).ok).toBe(true);
    expect((await storeApi.getSegment(SEED_STORE_ID, ID)).ok).toBe(true);

    const preview = await storeApi.previewSegment(SEED_STORE_ID, ID);
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    if (preview.ok) expect(typeof preview.data.count).toBe('number');

    // 202 with a body. `AdminResponse` maps 202 since #251 (d3f7754), so no cast is involved; this still
    // asserts the body really arrives, because a regression there would type as `null` without an error.
    const materialized = await storeApi.materializeSegment(SEED_STORE_ID, ID);
    expect(materialized.ok, JSON.stringify(materialized)).toBe(true);
    if (materialized.ok) expect(materialized.data).toHaveProperty('materialised_count');
  });

  it('Feeds: list, read, items and publish', async () => {
    expect((await storeApi.listFeeds(SEED_STORE_ID, { page: 1, limit: 20 })).ok).toBe(true);
    expect((await storeApi.getFeed(SEED_STORE_ID, ID)).ok).toBe(true);
    expect((await storeApi.listFeedItems(SEED_STORE_ID, ID, { limit: 10 })).ok).toBe(true);
    expect((await storeApi.publishFeed(SEED_STORE_ID, ID)).ok).toBe(true);
  });

  it('HQ: the cross-brand dashboard and the shared templates', async () => {
    const dashboard = await hqApi.getMarketingDashboard(WINDOW);
    expect(dashboard.ok, JSON.stringify(dashboard)).toBe(true);
    if (dashboard.ok) expect(Array.isArray(dashboard.data.items)).toBe(true);

    expect((await hqApi.listSegmentTemplates({ limit: 20 })).ok).toBe(true);
  });
});

describe('a refused principal gets data, not an exception', () => {
  /**
   * Every screen in the section branches on `result.ok` and hands a failure to `ApiStatePanel`, so what has to
   * hold is that a refusal arrives as a *result* — never as a throw that takes down the route.
   *
   * This is the `analyst` case from #149 under the manager's reading (a): the store section is gated on
   * `store_staff`, which an analyst does not hold, so their Overview is the HQ page. Whatever the relation, a
   * refusal on a marketing operation has to render the panel that names it.
   */
  it('a 403 on a marketing report resolves as ok:false with the contract error body', async () => {
    const refused = await adminCall<'getAttributionReport'>({
      path: buildPath('/admin/stores/{storeId}/marketing/reports/attribution', {
        storeId: SEED_STORE_ID,
      }),
      query: { from: WINDOW.from, to: WINDOW.to },
      headers: preferring(403),
    });

    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.status).toBe(403);
      // The shape `ApiStatePanel` reads to name the relation the principal is missing.
      expect(refused.error).toHaveProperty('code');
      expect(refused.error).toHaveProperty('message');
    }
  });
});

describe('the rule builder emits a body the contract accepts', () => {
  /** One complete row per field, with a value of the type that field requires. */
  const SAMPLE: Record<string, string> = {
    orders_count: '3',
    total_spent_minor: '50000',
    last_order_at: '2026-01-01',
    tags: 'wholesale',
    consent: 'email',
    country: 'NL, DE',
    customer_group_ids: '3f2a6d1e-4b7c-4a9e-8d5f-2c6b1a9e7d40',
  };

  it('accepts every field and operator of the closed set as a SegmentInput body', async () => {
    for (const spec of SEGMENT_FIELDS) {
      for (const { op } of spec.ops) {
        const rules = toRules([{ any: [{ field: spec.field, op, value: SAMPLE[spec.field]! }] }]);
        expect(rules, `${spec.field}.${op} produced no rules`).not.toBeNull();

        // Prism validates the body against `SegmentInput` → `SegmentRules`. A shape the grammar does not
        // allow comes back as a 4xx, so a green assertion here *is* the contract accepting the JSON.
        const created = await storeApi.createSegment(SEED_STORE_ID, {
          name: `contract-${spec.field}-${op}`,
          rules: rules!,
        });
        expect(created.ok, `${spec.field}.${op}: ${JSON.stringify(created)}`).toBe(true);
      }
    }
  }, 60_000);

  it('accepts an AND of ORs and an empty rule set', async () => {
    const both = toRules([
      {
        any: [
          { field: 'total_spent_minor', op: 'gte', value: '50000' },
          { field: 'orders_count', op: 'gte', value: '3' },
        ],
      },
      { any: [{ field: 'consent', op: 'granted', value: 'email' }] },
    ]);
    expect(
      (await storeApi.createSegment(SEED_STORE_ID, { name: 'contract-and-or', rules: both! })).ok,
    ).toBe(true);

    // `all: []` is the contract's "every customer of the store", not a malformed body.
    const empty = toRules([]);
    expect(empty).toEqual({ v: 1, all: [] });
    expect(
      (await storeApi.createSegment(SEED_STORE_ID, { name: 'contract-empty', rules: empty! })).ok,
    ).toBe(true);
  });
});
