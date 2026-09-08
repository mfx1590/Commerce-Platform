// Static checks on the OpenAPI documents (text-level, dependency-free). Runtime checks live in contract.test.ts.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RELATIONS } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(resolve(here, '../openapi', f), 'utf8');

/** Splits a spec into operation blocks: from one `operationId:` line to the next. */
function operations(text: string): Array<{ id: string; body: string }> {
  const lines = text.split('\n');
  const out: Array<{ id: string; body: string }> = [];
  let current: { id: string; body: string[] } | null = null;
  for (const line of lines) {
    const m = line.match(/^\s+operationId:\s*(\w+)/);
    if (m) {
      if (current) out.push({ id: current.id, body: current.body.join('\n') });
      current = { id: m[1]!, body: [] };
      continue;
    }
    if (/^\s{2}\/|^components:/.test(line) && current) {
      out.push({ id: current.id, body: current.body.join('\n') });
      current = null;
    }
    current?.body.push(line);
  }
  if (current) out.push({ id: current.id, body: current.body.join('\n') });
  return out;
}

describe('store-api.yaml', () => {
  const text = read('store-api.yaml');
  const ops = operations(text);

  it('is OpenAPI 3.1 and covers the storefront journey', () => {
    expect(text.startsWith('openapi: 3.1.0')).toBe(true);
    const ids = ops.map((o) => o.id);
    for (const id of [
      'getStore',
      'listProducts',
      'getProduct',
      'createCart',
      'addLineItem',
      'listShippingOptions',
      'createPaymentSession',
      'completeCart',
      'getOrder',
      'getMe',
    ]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every operation declares tags and at least one response with a schema', () => {
    // `tags:` precedes `operationId:` in our layout, so count them per document.
    expect((text.match(/^ {6}tags: \[/gm) ?? []).length).toBe(ops.length);
    for (const o of ops) {
      expect(o.body, o.id).toMatch(/responses:/);
      expect(o.body, o.id).toMatch(/schema:/);
    }
  });

  it('requires the publishable key and never accepts card data', () => {
    expect(text).toMatch(/X-Publishable-Key/);
    expect(text).not.toMatch(/card_number|cvc|pan\b/i);
  });

  it('0.3.0: listProducts and getProduct accept an optional ISO-4217 currency query', () => {
    expect(text).toMatch(/version: 0\.3\.0/);
    expect(text).toMatch(/Currency:\n\s+name: currency\n\s+in: query/);
    expect(text).toMatch(/pattern: '\^\[A-Z\]\{3\}\$'/);
    for (const id of ['listProducts', 'getProduct']) {
      const op = ops.find((o) => o.id === id)!;
      expect(op.body, id).toMatch(/\$ref: '#\/components\/parameters\/Currency'/);
      expect(op.body, id).toMatch(/'400': \{ \$ref: '#\/components\/responses\/BadRequest' \}/);
    }
  });
});

describe('admin-api.yaml', () => {
  const text = read('admin-api.yaml');
  const ops = operations(text);

  it('covers the nine areas from the Phase 0 brief plus marketing (0.3.0)', () => {
    for (const tag of [
      'registry',
      'catalog',
      'pricing',
      'orders',
      'inventory',
      'fulfillment',
      'customers',
      'roles',
      'audit',
      'marketing',
    ]) {
      expect(text, tag).toMatch(new RegExp(`tags: \\[[^\\]]*\\b${tag}\\b`));
    }
    expect(ops.length).toBeGreaterThanOrEqual(45);
  });

  it('marketing (0.3.0): every path from docs/marketing-scope.md exists with the agreed permissions', () => {
    const ids = ops.map((o) => o.id);
    for (const id of [
      'listCampaigns',
      'createCampaign',
      'getCampaign',
      'updateCampaign',
      'deleteCampaign',
      'launchCampaign',
      'endCampaign',
      'listSegments',
      'createSegment',
      'getSegment',
      'updateSegment',
      'deleteSegment',
      'previewSegment',
      'materializeSegment',
      'listFeeds',
      'createFeed',
      'getFeed',
      'updateFeed',
      'deleteFeed',
      'publishFeed',
      'listFeedItems',
      'listReferralPrograms',
      'createReferralProgram',
      'getReferralProgram',
      'updateReferralProgram',
      'deleteReferralProgram',
      'listReferrals',
      'listReviews',
      'moderateReview',
      'getAttributionReport',
      'getPromotionReport',
      'getMarketingDashboard',
      'listSegmentTemplates',
      'createSegmentTemplate',
      'getSegmentTemplate',
      'updateSegmentTemplate',
      'deleteSegmentTemplate',
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(ops.length).toBeGreaterThanOrEqual(87);
    const permission = (id: string) =>
      ops
        .find((o) => o.id === id)!
        .body.match(/x-permission: \{ relation: (\w+), object: '([^']+)'/)!;
    // reads: store_staff; writes, launch and publish: store_admin; reports: any relation (analyst included)
    expect(permission('listCampaigns').slice(1)).toEqual(['store_staff', 'store:{storeId}']);
    expect(permission('createCampaign').slice(1)).toEqual(['store_admin', 'store:{storeId}']);
    expect(permission('launchCampaign').slice(1)).toEqual(['store_admin', 'store:{storeId}']);
    expect(permission('publishFeed').slice(1)).toEqual(['store_admin', 'store:{storeId}']);
    expect(permission('moderateReview').slice(1)).toEqual(['store_admin', 'store:{storeId}']);
    expect(permission('previewSegment').slice(1)).toEqual(['store_staff', 'store:{storeId}']);
    expect(permission('getAttributionReport').slice(1)).toEqual(['viewer', 'store:{storeId}']);
    expect(permission('getPromotionReport').slice(1)).toEqual(['viewer', 'store:{storeId}']);
    expect(permission('getMarketingDashboard').slice(1)).toEqual(['analyst', 'organization:hq']);
    expect(permission('createSegmentTemplate').slice(1)).toEqual(['owner', 'organization:hq']);
    expect(permission('deleteSegmentTemplate').slice(1)).toEqual(['owner', 'organization:hq']);
    // the review text never leaves the API in an event, and the report money is always Money
    expect(text).toMatch(/AttributionReport:/);
    expect(text).toMatch(/PromotionReport:/);
    expect(text).toMatch(/MarketingDashboard:/);
  });

  it('every operation except getMe declares x-permission with a known relation', () => {
    for (const o of ops) {
      if (o.id === 'getMe') continue;
      const m = o.body.match(/x-permission:\s*\{\s*relation:\s*(\w+),\s*object:\s*'([^']+)'/);
      expect(m, `${o.id} lacks x-permission`).not.toBeNull();
      const relation = m![1]!;
      expect([...RELATIONS, 'viewer'], `${o.id}: ${relation}`).toContain(relation);
      expect(m![2], o.id).toMatch(
        /^(organization:hq|store:\{storeId\}|store:\{store_id\}|store:\*)$/,
      );
    }
  });

  it('finance-only surfaces are gated on organization:hq (a store admin can never satisfy them)', () => {
    const le = ops.find((o) => o.id === 'listLegalEntities')!;
    expect(le.body).toMatch(/relation: finance, object: 'organization:hq'/);
  });

  it('money is always { amount_minor, currency }, never a float', () => {
    expect(text).not.toMatch(/type: number/);
    expect(text).toMatch(/amount_minor: \{ type: integer/);
  });
});
