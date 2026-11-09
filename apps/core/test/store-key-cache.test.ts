// #742, the pool knee: GET /store takes ONE pooled connection when its key is cached (two when not), where it took
// five (the key lookup, then four reads in parallel). The publishable-key resolve cache is positive only, dropped in
// this process on a revoke or a store update, and bounded by CORE_STORE_KEY_CACHE_MS for every other process.
import express from 'express';
import request from 'supertest';
import { createOrganizationClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DevTokenVerifier } from '../src/http';
import { closePool, getPool, initDb } from '../src/lib/db';
import { storeKeyCache } from '../src/lib/store-key-cache';
import { createApiKey, revokeApiKey, updateStore } from '../src/modules/registry';
import { mountCoreMiddleware } from '../src/server';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const C = SEED_IDS.stores.brandC;
const KEY_A = SEED_IDS.publishableKeys.brandA;
const KEY_C = SEED_IDS.publishableKeys.brandC;

let db: TestDatabase;
let app: express.Express;
let hq: ReturnType<typeof createOrganizationClient>;

/** Pool connections taken while `fn` runs. */
async function connectionsDuring(fn: () => Promise<unknown>): Promise<number> {
  const spy = vi.spyOn(getPool(), 'connect');
  try {
    await fn();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

const getStore = (key: string) => request(app).get('/store').set('X-Publishable-Key', key);

beforeAll(async () => {
  db = await createTestDatabase('core_store_key_cache');
  await seed(db.owner, { productsPerStore: 1, log: () => {} });
  process.env.CORE_ORGANIZATION_ID = ORG;
  await initDb({ connectionString: db.app.options.connectionString! });
  hq = createOrganizationClient(db.app, { organizationId: ORG });
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier());
}, 180_000);

afterEach(() => {
  delete process.env.CORE_STORE_KEY_CACHE_MS;
  storeKeyCache.clear();
});

afterAll(async () => {
  await closePool();
  await db?.drop();
});

describe('GET /store and the pool (#742)', () => {
  it('one connection with the key cached, two without; the answer is the same', async () => {
    const cold = await getStore(KEY_A).expect(200); // resolves and caches the key
    expect(await connectionsDuring(() => getStore(KEY_A).expect(200))).toBe(1);
    storeKeyCache.clear();
    let again: request.Response | undefined;
    expect(await connectionsDuring(async () => (again = await getStore(KEY_A).expect(200)))).toBe(
      2,
    );
    expect(again!.body).toEqual(cold.body);
    expect(cold.body.id).toBe(A);
  });

  it('CORE_STORE_KEY_CACHE_MS=0 turns the cache off: every request resolves the key', async () => {
    process.env.CORE_STORE_KEY_CACHE_MS = '0';
    await getStore(KEY_A).expect(200);
    expect(storeKeyCache.size).toBe(0);
    expect(await connectionsDuring(() => getStore(KEY_A).expect(200))).toBe(2);
  });
});

describe('the key resolve cache (#742)', () => {
  it('never caches an unknown key: it reaches the database every time, and works as soon as it exists', async () => {
    const created = await createApiKey(hq, A, { name: 'later', type: 'publishable' });
    await revokeApiKey(hq, A, created.id); // a key that does not resolve
    for (let i = 0; i < 2; i++) {
      expect(await connectionsDuring(() => getStore(created.key).expect(401))).toBe(1);
    }
    expect(await connectionsDuring(() => getStore('pk_unknown_000').expect(401))).toBe(1);
    expect(storeKeyCache.size).toBe(0);
    const fresh = await createApiKey(hq, A, { name: 'fresh', type: 'publishable' });
    await getStore(fresh.key).expect(200);
  });

  it('a key this process revokes stops resolving at once, although it was cached', async () => {
    const created = await createApiKey(hq, A, { name: 'temp', type: 'publishable' });
    await getStore(created.key).expect(200);
    expect(await connectionsDuring(() => getStore(created.key).expect(200))).toBe(1); // cached
    await revokeApiKey(hq, A, created.id);
    await getStore(created.key).expect(401);
  });

  it("a store update in this process drops its keys' entries (an archive is a 401 at once)", async () => {
    await getStore(KEY_C).expect(200);
    expect(await connectionsDuring(() => getStore(KEY_C).expect(200))).toBe(1); // cached
    await updateStore(hq, C, { status: 'archived' });
    const res = await getStore(KEY_C).expect(401);
    expect(res.body.message).toBe('store is archived');
  });

  it('a revoke by ANOTHER process is honoured within CORE_STORE_KEY_CACHE_MS (the documented bound)', async () => {
    process.env.CORE_STORE_KEY_CACHE_MS = '300';
    const created = await createApiKey(hq, A, { name: 'elsewhere', type: 'publishable' });
    await getStore(created.key).expect(200);
    // what another process's revoke looks like from here: the row changes, this process's cache does not hear of it
    const owner = createOrganizationClient(db.owner, { organizationId: ORG });
    await owner.query('UPDATE store_api_key SET revoked_at = now() WHERE id = $1', [created.id]);
    await getStore(created.key).expect(200); // still cached
    await new Promise((r) => setTimeout(r, 350));
    await getStore(created.key).expect(401);
  });
});
