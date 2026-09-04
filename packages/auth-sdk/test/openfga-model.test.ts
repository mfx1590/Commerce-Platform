// OpenFGA authorization model + seed tuples (infra/openfga, issue #11).
// Static part: relation names vs @platform/contracts RELATIONS, tuples vs SEED_IDS. Always runs.
// Live part: throw-away store on docker OpenFGA (OPENFGA_API_URL, default :8081); skipped when unreachable.
import { OpenFgaClient } from '@openfga/sdk';
import { RELATIONS } from '@platform/contracts';
import { SEED_IDS } from '@platform/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAuthorizationModel, loadSeedTuples, seedOpenFga } from '../src/index.js';

const model = loadAuthorizationModel();
const tuples = loadSeedTuples();
const ORG = 'organization:hq';
const U = SEED_IDS.users;
const S = SEED_IDS.stores;
const user = (id: string) => `user:${id}`;
const store = (id: string) => `store:${id}`;

const relationsOf = (type: string) =>
  Object.keys(model.type_definitions.find((t) => t.type === type)?.relations ?? {});

describe('model.fga (static)', () => {
  it('declares exactly the ADR 0002 types', () => {
    expect(model.schema_version).toBe('1.1');
    expect(model.type_definitions.map((t) => t.type).sort()).toEqual([
      'organization',
      'store',
      'user',
    ]);
  });

  it('organization and store relations are the frozen names (+ viewer, + store.organization)', () => {
    expect(relationsOf('organization').sort()).toEqual(
      ['owner', 'finance', 'operations', 'analyst', 'support', 'viewer'].sort(),
    );
    expect(relationsOf('store').sort()).toEqual(
      ['organization', 'store_admin', 'store_staff', 'support', 'analyst', 'viewer'].sort(),
    );
  });

  it('every relation name in the model is in RELATIONS (or the structural viewer/organization)', () => {
    const allowed = new Set<string>([...RELATIONS, 'viewer', 'organization']);
    for (const type of ['organization', 'store']) {
      for (const r of relationsOf(type)) expect(allowed.has(r), `${type}.${r}`).toBe(true);
    }
  });

  it('every RELATIONS entry is assignable somewhere in the model', () => {
    const assignable = new Set([...relationsOf('organization'), ...relationsOf('store')]);
    for (const r of RELATIONS) expect(assignable.has(r), r).toBe(true);
  });
});

describe('tuples.seed.json (static)', () => {
  it('mirrors the seeded role_assignment rows and links every store to organization:hq', () => {
    const expected = [
      { user: ORG, relation: 'organization', object: store(S.brandA) },
      { user: ORG, relation: 'organization', object: store(S.brandB) },
      { user: ORG, relation: 'organization', object: store(S.brandC) },
      { user: user(U.owner), relation: 'owner', object: ORG },
      { user: user(U.finance), relation: 'finance', object: ORG },
      { user: user(U.operations), relation: 'operations', object: ORG },
      { user: user(U.support), relation: 'support', object: ORG },
      { user: user(U.analyst), relation: 'analyst', object: ORG },
      { user: user(U.storeAdmin), relation: 'store_admin', object: store(S.brandA) },
      { user: user(U.storeAdmin), relation: 'store_admin', object: store(S.brandB) },
      { user: user(U.storeStaff), relation: 'store_staff', object: store(S.brandA) },
    ];
    const key = (t: { user: string; relation: string; object: string }) =>
      `${t.user}#${t.relation}@${t.object}`;
    expect(tuples.map(key).sort()).toEqual(expected.map(key).sort());
  });

  it('uses only RELATIONS (plus the structural organization link) and never viewer', () => {
    const allowed = new Set<string>([...RELATIONS, 'organization']);
    for (const t of tuples) expect(allowed.has(t.relation), t.relation).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
const API = process.env.OPENFGA_API_URL ?? 'http://localhost:8081';
async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/healthz`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}
const live = await reachable();

describe.runIf(live)('model checks (live OpenFGA, throw-away store)', () => {
  const storeName = `test-${Date.now()}`;
  let client: OpenFgaClient;
  let storeId: string;
  const check = (u: string, relation: string, object: string) =>
    client.check({ user: u, relation, object }).then((r) => r.allowed === true);

  beforeAll(async () => {
    const seeded = await seedOpenFga({ apiUrl: API, storeName });
    client = seeded.client;
    storeId = seeded.storeId;
    expect(seeded.storeCreated).toBe(true);
    expect(seeded.tuplesWritten).toBe(tuples.length);
  });
  afterAll(async () => {
    if (storeId) await new OpenFgaClient({ apiUrl: API, storeId }).deleteStore();
  });

  it('seeding again is idempotent (store reused, 0 written, all skipped)', async () => {
    const again = await seedOpenFga({ apiUrl: API, storeName });
    expect(again.storeCreated).toBe(false);
    expect(again.storeId).toBe(storeId);
    expect(again.tuplesWritten).toBe(0);
    expect(again.tuplesSkipped).toBe(tuples.length);
  });

  it('store-admin is store_admin on brand-a and brand-b, not on brand-c', async () => {
    expect(await check(user(U.storeAdmin), 'store_admin', store(S.brandA))).toBe(true);
    expect(await check(user(U.storeAdmin), 'store_admin', store(S.brandB))).toBe(true);
    expect(await check(user(U.storeAdmin), 'store_admin', store(S.brandC))).toBe(false);
    expect(await check(user(U.storeAdmin), 'viewer', store(S.brandC))).toBe(false);
  });

  it('store-admin of two stores is NOT finance (nor viewer) on organization:hq', async () => {
    expect(await check(user(U.storeAdmin), 'finance', ORG)).toBe(false);
    expect(await check(user(U.storeAdmin), 'viewer', ORG)).toBe(false);
    expect(await check(user(U.storeAdmin), 'owner', ORG)).toBe(false);
  });

  it('owner implies every organization relation and viewer/store_admin on every store', async () => {
    for (const r of ['finance', 'operations', 'analyst', 'support', 'viewer']) {
      expect(await check(user(U.owner), r, ORG), r).toBe(true);
    }
    const stores = await client.listObjects({
      user: user(U.owner),
      relation: 'viewer',
      type: 'store',
    });
    expect(stores.objects.sort()).toEqual(
      [store(S.brandA), store(S.brandB), store(S.brandC)].sort(),
    );
    expect(await check(user(U.owner), 'store_admin', store(S.brandC))).toBe(true);
  });

  it('finance and operations see every store but are not store_admin anywhere', async () => {
    for (const id of [U.finance, U.operations]) {
      const stores = await client.listObjects({
        user: user(id),
        relation: 'viewer',
        type: 'store',
      });
      expect(stores.objects).toHaveLength(3);
      expect(await check(user(id), 'store_admin', store(S.brandA))).toBe(false);
    }
    expect(await check(user(U.operations), 'finance', ORG)).toBe(false);
  });

  it('store_admin implies store_staff and support on the same store', async () => {
    expect(await check(user(U.storeAdmin), 'store_staff', store(S.brandA))).toBe(true);
    expect(await check(user(U.storeAdmin), 'support', store(S.brandA))).toBe(true);
    expect(await check(user(U.storeStaff), 'store_admin', store(S.brandA))).toBe(false);
    expect(await check(user(U.storeStaff), 'viewer', store(S.brandA))).toBe(true);
    expect(await check(user(U.storeStaff), 'viewer', store(S.brandB))).toBe(false);
  });

  it('organization support and analyst reach every store through the organization link', async () => {
    expect(await check(user(U.support), 'support', store(S.brandB))).toBe(true);
    expect(await check(user(U.analyst), 'analyst', store(S.brandC))).toBe(true);
    expect(await check(user(U.analyst), 'viewer', store(S.brandC))).toBe(true);
    expect(await check(user(U.analyst), 'store_staff', store(S.brandC))).toBe(false);
    expect(await check(user(U.analyst), 'finance', ORG)).toBe(false);
  });

  it('listObjects for store-admin returns exactly brand-a and brand-b', async () => {
    const stores = await client.listObjects({
      user: user(U.storeAdmin),
      relation: 'viewer',
      type: 'store',
    });
    expect(stores.objects.sort()).toEqual([store(S.brandA), store(S.brandB)].sort());
  });
});
