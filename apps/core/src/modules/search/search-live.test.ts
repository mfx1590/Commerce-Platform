// Live Algolia round trip. Skips unless ALGOLIA_APP_ID + ALGOLIA_ADMIN_API_KEY are set (repo-root .env or the
// CI environment). Uses a throwaway index `test_products_<random>` and deletes it afterwards. Credentials are
// read from the environment only — never from code.
import { loadDotenv } from '@platform/db';
import { afterAll, describe, expect, it } from 'vitest';
import { AlgoliaIndexClient } from './algolia-client';
import { primarySettings, replicaNameFor, replicaSettings } from './settings';
import type { SearchRecord } from './types';

loadDotenv();
const appId = process.env.ALGOLIA_APP_ID;
const apiKey = process.env.ALGOLIA_ADMIN_API_KEY;
const live = Boolean(appId && apiKey);

const indexName = `test_products_${Math.random().toString(36).slice(2, 10)}`;
const client = live
  ? new AlgoliaIndexClient({ appId: appId!, apiKey: apiKey!, waitForTasks: true })
  : undefined;

const record = (i: number): SearchRecord => ({
  objectID: `p${i}`,
  store_id: 'store',
  handle: `handle-${i}`,
  title: `Live product ${i}`,
  subtitle: null,
  description: null,
  brand_name: null,
  tags: ['live'],
  category_id: null,
  category_handle: null,
  category_name: null,
  category_path: [],
  thumbnail_url: null,
  published_at: new Date().toISOString(),
  published_at_ts: Math.floor(Date.now() / 1000),
  attributes: {},
  variants: [],
  price_minor: { EUR: 100 * i },
  price_max_minor: { EUR: 100 * i },
  compare_at_minor: {},
  currencies: ['EUR'],
  in_stock: true,
  available_quantity: null,
  updated_at: new Date().toISOString(),
});

afterAll(async () => {
  if (!client) return;
  const store = { code: 'live', search_index: indexName, default_currency: 'EUR' };
  // replicas must be detached from the primary before either side can be deleted
  await client.setSettings(indexName, { replicas: [] }).catch(() => {});
  for (const replica of primarySettings(store).replicas ?? []) {
    await client.deleteIndex(replica).catch(() => {});
  }
  await client.deleteIndex(indexName).catch(() => {});
});

describe.skipIf(!live)('Algolia live (ALGOLIA_APP_ID + ALGOLIA_ADMIN_API_KEY)', () => {
  it('writes settings, upserts, browses, deletes and keeps the cursor in userData', async () => {
    const c = client!;
    const store = { code: 'live', search_index: indexName, default_currency: 'EUR' };
    await c.setSettings(indexName, primarySettings(store));
    await c.setSettings(
      replicaNameFor(indexName, 'price_asc'),
      replicaSettings(store, 'price_asc'),
    );

    await c.saveObjects(indexName, [record(1), record(2)]);
    await c.saveObjects(indexName, [record(2)]); // idempotent
    expect((await c.browseObjectIDs(indexName)).sort()).toEqual(['p1', 'p2']);

    await c.setSettings(indexName, { userData: { outbox_cursor: 12 } });
    const settings = await c.getSettings(indexName);
    expect(settings.userData).toEqual({ outbox_cursor: 12 });
    expect(settings.replicas).toContain(replicaNameFor(indexName, 'price_asc'));

    await c.deleteObjects(indexName, ['p1']);
    expect(await c.browseObjectIDs(indexName)).toEqual(['p2']);
  }, 120_000);
});
