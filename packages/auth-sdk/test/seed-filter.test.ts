// #832: fga:seed skips a seed tuple about a store the database does not have. On the shared dev stack brand-d is the
// onboarding wizard's store and the seed skips D, so `organization:hq → store:<D's seeded id>` would put an id with no
// store row into every HQ scope (ListObjects answers ids straight from OpenFGA).
import { SEED_IDS } from '@platform/db';
import { describe, expect, it } from 'vitest';
import { loadSeedTuples, withoutAbsentStores } from '../src/index.js';

const S = SEED_IDS.stores;

describe('withoutAbsentStores (#832)', () => {
  it('drops exactly the tuples about a store with no row, one log line each, and keeps everything else', () => {
    const tuples = loadSeedTuples();
    const lines: string[] = [];
    const present = new Set<string>([S.brandA, S.brandB, S.brandC]); // the shared dev DB: brand D is not the seed's
    const kept = withoutAbsentStores(tuples, present, (m) => lines.push(m));
    const dropped = tuples.filter((t) => !kept.includes(t));
    expect(dropped).toEqual([
      { user: 'organization:hq', relation: 'organization', object: `store:${S.brandD}` },
    ]);
    expect(lines).toEqual([
      `skipped organization:hq#organization@store:${S.brandD}: no store row with that id in this database`,
    ]);
    // organization tuples and the other stores' tuples are untouched
    expect(kept.length).toBe(tuples.length - 1);
    expect(kept.some((t) => t.object === 'organization:hq')).toBe(true);
  });

  it('keeps every tuple, with one line, when the database has no store row at all (db:seed has not run yet)', () => {
    const tuples = loadSeedTuples();
    const lines: string[] = [];
    const kept = withoutAbsentStores(tuples, new Set<string>(), (m) => lines.push(m));
    expect(kept).toEqual(tuples);
    expect(kept.filter((t) => t.object.startsWith('store:')).length).toBeGreaterThanOrEqual(4); // A–D's org tuples
    expect(lines).toEqual([
      'the database has no stores yet (not seeded): writing every seed tuple',
    ]);
  });

  it('keeps every tuple when the database has every seeded store (a freshly seeded one, CI)', () => {
    const tuples = loadSeedTuples();
    const all = new Set<string>(Object.values(S));
    expect(withoutAbsentStores(tuples, all)).toEqual(tuples);
  });
});
