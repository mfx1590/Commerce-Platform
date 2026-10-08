// Store object registration + reconciliation (issue #415, task 3.1a).
// Unit part: a scripted OpenFGA client (read/write recorded; duplicate 400; outage). Live part: a throw-away
// OpenFGA store seeded from infra/openfga, a throw-away Postgres database for the reconcile report.
import { createOpenFgaClient, seedOpenFga, type OpenFgaClient } from '../src/index.js';
import {
  ensureStoreObject,
  reconcileStoreObjects,
  resetStoreObjectClient,
  storeObjectTuple,
} from '../src/index.js';
import { seed, SEED_IDS } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { createOrganizationClient } from '@platform/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const API = process.env.OPENFGA_API_URL ?? 'http://localhost:8081';
const STORE_ID = '00000000-0000-4000-8000-00000000aa01';

/** A scripted OpenFGA client: `present` answers reads; `failWrite` / `down` script the failure modes. */
function fakeFga(opts: { present?: boolean; failWrite?: unknown; down?: boolean } = {}) {
  const reads: unknown[] = [];
  const writes: unknown[] = [];
  const client = {
    async read(body: unknown) {
      if (opts.down) throw new Error('connect ECONNREFUSED 127.0.0.1:8081');
      reads.push(body);
      return { tuples: opts.present ? [{ key: body }] : [] };
    },
    async write(body: unknown) {
      if (opts.down) throw new Error('connect ECONNREFUSED 127.0.0.1:8081');
      writes.push(body);
      if (opts.failWrite) throw opts.failWrite;
      return {};
    },
  };
  return { client: client as unknown as OpenFgaClient, reads, writes };
}

describe('ensureStoreObject (unit, scripted OpenFGA)', () => {
  beforeEach(resetStoreObjectClient);

  it('writes organization:hq#organization@store:<id> when missing and reports created: true', async () => {
    const f = fakeFga();
    const r = await ensureStoreObject(STORE_ID, { fga: f.client });
    expect(r).toEqual({
      object: `store:${STORE_ID}`,
      organization: 'organization:hq',
      created: true,
    });
    expect(f.reads).toEqual([storeObjectTuple(STORE_ID)]);
    expect(f.writes).toEqual([{ writes: [storeObjectTuple(STORE_ID)] }]);
  });

  it('is idempotent: an existing tuple means no write and created: false', async () => {
    const f = fakeFga({ present: true });
    const r = await ensureStoreObject(STORE_ID, { fga: f.client });
    expect(r.created).toBe(false);
    expect(f.writes).toEqual([]);
  });

  it("tolerates a concurrent duplicate write (OpenFGA's 400 'already exists') as created: false", async () => {
    const dup = Object.assign(new Error('tuple to be written already exists'), { statusCode: 400 });
    const f = fakeFga({ failWrite: dup });
    await expect(ensureStoreObject(STORE_ID, { fga: f.client })).resolves.toMatchObject({
      created: false,
    });
  });

  it('another organization slug: organization:<slug>', async () => {
    const f = fakeFga();
    const r = await ensureStoreObject(STORE_ID, { fga: f.client, organization: 'acme' });
    expect(r.organization).toBe('organization:acme');
    expect(f.writes).toEqual([{ writes: [storeObjectTuple(STORE_ID, 'acme')] }]);
  });

  it('refuses a non-uuid store id with the contract 400 before touching OpenFGA', async () => {
    const f = fakeFga();
    await expect(ensureStoreObject('brand-a', { fga: f.client })).rejects.toMatchObject({
      status: 400,
      code: 'validation_error',
      details: { field: 'storeId' },
    });
    expect(f.reads).toEqual([]);
  });

  it('fails closed: OpenFGA unreachable → 503, on the read and on the write', async () => {
    await expect(
      ensureStoreObject(STORE_ID, { fga: fakeFga({ down: true }).client }),
    ).rejects.toMatchObject({ status: 503, code: 'internal' });
    const other = Object.assign(new Error('internal server error'), { statusCode: 500 });
    await expect(
      ensureStoreObject(STORE_ID, { fga: fakeFga({ failWrite: other }).client }),
    ).rejects.toMatchObject({ status: 503, code: 'internal' });
  });
});

async function up(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}
const fgaUp = await up(`${API}/healthz`);
const dbUp = Boolean(process.env.DATABASE_URL);

describe.runIf(fgaUp)('ensureStoreObject (live OpenFGA, throw-away store)', () => {
  let fga: OpenFgaClient;
  let fgaStoreId: string;

  beforeAll(async () => {
    const seeded = await seedOpenFga({ apiUrl: API, storeName: `store-object-test-${Date.now()}` });
    fga = seeded.client;
    fgaStoreId = seeded.storeId;
  }, 60_000);
  afterAll(async () => {
    if (fgaStoreId) await createOpenFgaClient({ apiUrl: API, storeId: fgaStoreId }).deleteStore();
  });

  it('twice → one tuple, and the seeded owner can view the store afterwards (owner from organization)', async () => {
    const storeId = randomUUID();
    const before = await fga.check({
      user: `user:${SEED_IDS.users.owner}`,
      relation: 'viewer',
      object: `store:${storeId}`,
    });
    expect(before.allowed).toBe(false);

    const first = await ensureStoreObject(storeId, { fga });
    const second = await ensureStoreObject(storeId, { fga });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    const tuples = await fga.read({ object: `store:${storeId}` });
    expect(tuples.tuples.map((t) => t.key)).toEqual([storeObjectTuple(storeId)]);

    const after = await fga.check({
      user: `user:${SEED_IDS.users.owner}`,
      relation: 'viewer',
      object: `store:${storeId}`,
    });
    expect(after.allowed).toBe(true);
    // A store-admin of brand A and brand B still sees nothing of the new store.
    const storeAdmin = await fga.check({
      user: `user:${SEED_IDS.users.storeAdmin}`,
      relation: 'viewer',
      object: `store:${storeId}`,
    });
    expect(storeAdmin.allowed).toBe(false);
  });
});

describe.runIf(fgaUp && dbUp)('reconcileStoreObjects (live OpenFGA + throw-away Postgres)', () => {
  let db: TestDatabase;
  let fga: OpenFgaClient;
  let fgaStoreId: string;
  const extraStoreId = randomUUID();

  beforeAll(async () => {
    db = await createTestDatabase('platform_store_object');
    await seed(db.owner, { productsPerStore: 1, log: () => {} });
    // A fourth store created "through the API" before #415: a row, no tuple.
    await db.owner.query(
      `INSERT INTO store (id, organization_id, legal_entity_id, code, name, default_currency, default_locale, default_country)
       VALUES ($1, $2, $3, 'brand-d', 'Brand D', 'EUR', 'en-GB', 'GB')`,
      [extraStoreId, SEED_IDS.organization, SEED_IDS.legalEntities.brandA],
    );
    const seeded = await seedOpenFga({
      apiUrl: API,
      storeName: `store-reconcile-test-${Date.now()}`,
    });
    fga = seeded.client;
    fgaStoreId = seeded.storeId;
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
    if (fgaStoreId) await createOpenFgaClient({ apiUrl: API, storeId: fgaStoreId }).deleteStore();
  });

  it('lists the store without its tuple, --fix writes it, the report is empty afterwards', async () => {
    const orgDb = createOrganizationClient(db.app, {
      organizationId: SEED_IDS.organization,
      actorId: null,
    });
    const report = await reconcileStoreObjects(orgDb, { fga });
    expect(report.organization).toBe('organization:hq');
    expect(report.stores.map((s) => s.code)).toEqual(['brand-a', 'brand-b', 'brand-c', 'brand-d']);
    expect(report.missing).toEqual([{ id: extraStoreId, code: 'brand-d' }]);
    expect(report.fixed).toEqual([]);

    const fixed = await reconcileStoreObjects(orgDb, { fga, fix: true });
    expect(fixed.missing).toEqual([{ id: extraStoreId, code: 'brand-d' }]);
    expect(fixed.fixed).toEqual([{ id: extraStoreId, code: 'brand-d' }]);

    const after = await reconcileStoreObjects(orgDb, { fga });
    expect(after.missing).toEqual([]);
    expect(after.fixed).toEqual([]);
    const owner = await fga.check({
      user: `user:${SEED_IDS.users.owner}`,
      relation: 'viewer',
      object: `store:${extraStoreId}`,
    });
    expect(owner.allowed).toBe(true);
  });
});
