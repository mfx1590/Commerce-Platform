import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mergePackageJson } from '../scripts/merge-package-json.mjs';

/**
 * The `package.json` MERGE mode.
 *
 * The contract has exactly two halves, and a test that only checks one is worthless: a merge that
 * returns the starter's file passes "a starter script arrives", and a merge that returns the
 * brand's passes "the brand's name survives". Every case below asserts both directions.
 *
 * The bug this exists to prevent already happened once. `package.json` was preserved wholesale, so
 * the `perf` and `bundle-budget` scripts the starter added in its 2.3 never reached brand A. It was
 * found by hand during 2.2, by diffing the two files on a hunch.
 */

type Pkg = Record<string, unknown> & {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const starter: Pkg = {
  name: '@platform/storefront-starter',
  version: '0.12.0',
  scripts: {
    dev: 'next dev --port 3100',
    build: 'next build',
    test: 'vitest run',
    perf: 'node scripts/perf.mjs',
  },
  dependencies: { next: '15.5.25' },
  devDependencies: { vitest: '^3.2.0' },
};

const brand: Pkg = {
  name: '@platform/storefront-brand-a',
  version: '0.2.1',
  scripts: {
    dev: 'next dev --port 3101',
    build: 'next build',
    test: 'vitest run',
    sync: 'node scripts/sync-from-starter.mjs',
  },
  dependencies: { next: '15.5.0' },
  devDependencies: { '@axe-core/playwright': '^4.10.0' },
};

describe('package.json merge: what ARRIVES from the starter', () => {
  const merged = mergePackageJson(starter, brand) as Pkg;

  it('brings a script the starter added and the brand has never seen', () => {
    // The exact regression: `perf` existed upstream for a whole task and never arrived.
    expect(merged.scripts?.perf).toBe('node scripts/perf.mjs');
  });

  it('brings a dependency version bump for a package both declare', () => {
    expect(merged.dependencies?.next).toBe('15.5.25');
  });

  it('brings a top-level field the starter adds', () => {
    const withField = mergePackageJson({ ...starter, packageManager: 'pnpm@10' }, brand) as Pkg;
    expect(withField.packageManager).toBe('pnpm@10');
  });

  it('brings a changed body for a shared script', () => {
    const changed = mergePackageJson(
      { ...starter, scripts: { ...starter.scripts, build: 'next build --turbo' } },
      brand,
    ) as Pkg;
    expect(changed.scripts?.build).toBe('next build --turbo');
  });
});

describe('package.json merge: what SURVIVES from the brand', () => {
  const merged = mergePackageJson(starter, brand) as Pkg;

  it("keeps the brand name and version, not the starter's", () => {
    expect(merged.name).toBe('@platform/storefront-brand-a');
    expect(merged.version).toBe('0.2.1');
  });

  it("keeps the brand dev port — taking the starter's would move the app to 3100", () => {
    expect(merged.scripts?.dev).toBe('next dev --port 3101');
  });

  it('keeps a brand-only script the starter has no notion of', () => {
    expect(merged.scripts?.sync).toBe('node scripts/sync-from-starter.mjs');
  });

  it('keeps a brand-only dependency', () => {
    expect(merged.devDependencies?.['@axe-core/playwright']).toBe('^4.10.0');
  });

  it('keeps a brand-only top-level field', () => {
    const withExtra = mergePackageJson(starter, { ...brand, brandNotes: 'keep me' }) as Pkg;
    expect(withExtra.brandNotes).toBe('keep me');
  });

  it('does not mutate either input', () => {
    const starterBefore = JSON.stringify(starter);
    const brandBefore = JSON.stringify(brand);
    mergePackageJson(starter, brand);
    expect(JSON.stringify(starter)).toBe(starterBefore);
    expect(JSON.stringify(brand)).toBe(brandBefore);
  });

  it('sorts dependency blocks, so a merge does not churn the diff', () => {
    const m = mergePackageJson(
      { ...starter, dependencies: { zod: '^3', next: '15.5.25' } },
      brand,
    ) as Pkg;
    expect(Object.keys(m.dependencies ?? {})).toEqual(['next', 'zod']);
  });
});

describe('package.json merge: what the starter DELETES', () => {
  /**
   * The gap #288's review found: a key the brand has and the starter does not is ambiguous — either
   * the brand added it, or the starter removed it and the brand is holding a corpse. Without a
   * record of what the starter used to have, the merge kept both forever.
   *
   * `previousStarter` is that record. Every test here pairs the deletion case with the brand-only
   * case, because a merge that dropped *everything* brand-only would pass a deletion test on its own.
   */
  const previous = {
    ...starter,
    scripts: { ...starter.scripts, legacy: 'node scripts/legacy.mjs' },
    devDependencies: { ...starter.devDependencies, 'old-tool': '^1.0.0' },
    legacyField: 'gone upstream',
  };

  /** The brand, still carrying what the starter has since removed — plus its own additions. */
  const brandWithCorpses: Pkg = {
    ...brand,
    scripts: { ...brand.scripts, legacy: 'node scripts/legacy.mjs' },
    devDependencies: { ...brand.devDependencies, 'old-tool': '^1.0.0' },
    legacyField: 'gone upstream',
  };

  it('drops a script the starter deleted', () => {
    const merged = mergePackageJson(starter, brandWithCorpses, previous) as Pkg;
    expect(merged.scripts).not.toHaveProperty('legacy');
  });

  it('drops a dependency the starter deleted', () => {
    const merged = mergePackageJson(starter, brandWithCorpses, previous) as Pkg;
    expect(merged.devDependencies).not.toHaveProperty('old-tool');
  });

  it('drops a top-level field the starter deleted', () => {
    const merged = mergePackageJson(starter, brandWithCorpses, previous) as Pkg;
    expect(merged).not.toHaveProperty('legacyField');
  });

  it('keeps what the brand itself added, in the same pass — not just deleting everything', () => {
    // The paired assertion. Without it, `return starter` would pass all three tests above.
    const merged = mergePackageJson(starter, brandWithCorpses, previous) as Pkg;
    expect(merged.scripts?.sync).toBe('node scripts/sync-from-starter.mjs');
    expect(merged.devDependencies?.['@axe-core/playwright']).toBe('^4.10.0');
    expect(merged.name).toBe('@platform/storefront-brand-a');
    expect(merged.scripts?.dev).toBe('next dev --port 3101');
  });

  it('drops nothing at all when there is no record to justify it', () => {
    // First sync after this feature, or a fresh clone. Deleting a brand's dependency for lack of
    // evidence is the worse failure, so the ambiguous case stays conservative.
    const merged = mergePackageJson(starter, brandWithCorpses) as Pkg;
    expect(merged.scripts?.legacy).toBe('node scripts/legacy.mjs');
    expect(merged.devDependencies?.['old-tool']).toBe('^1.0.0');
    expect(merged.legacyField).toBe('gone upstream');
  });

  it('keeps a brand-only key that the previous starter never had', () => {
    // `sync` and `@axe-core/playwright` are absent from `previous`, so they are the brand's own and
    // must survive even though the record exists.
    const merged = mergePackageJson(starter, brandWithCorpses, previous) as Pkg;
    expect(merged.scripts).toHaveProperty('sync');
    expect(merged.devDependencies).toHaveProperty('@axe-core/playwright');
  });

  it('survives a starter RENAME of an identity script, and still drops a real deletion', () => {
    // Paired on purpose. `dev` is identity: the starter renaming it to `dev:web` puts the old name
    // in the record and not in the starter, which looks exactly like a deletion — and dropping it
    // would take brand A's port with it. `legacy` in the same merge is NOT identity, so it must
    // still go, or "never delete anything" would pass this test.
    const renamed = {
      ...starter,
      scripts: Object.fromEntries(
        Object.entries(starter.scripts ?? {}).map(([k, v]) =>
          k === 'dev' ? ['dev:web', v] : [k, v],
        ),
      ),
    };
    const merged = mergePackageJson(renamed, brandWithCorpses, previous) as Pkg;

    expect(merged.scripts?.dev, 'the brand port was dropped by a rename').toBe(
      'next dev --port 3101',
    );
    expect(merged.scripts?.['dev:web']).toBe('next dev --port 3100');
    expect(merged.scripts, 'a non-identity deletion should still drop').not.toHaveProperty(
      'legacy',
    );
  });

  it('still lets the starter re-add something it once deleted', () => {
    const readded = { ...starter, scripts: { ...starter.scripts, legacy: 'node scripts/new.mjs' } };
    const merged = mergePackageJson(readded, brandWithCorpses, previous) as Pkg;
    expect(merged.scripts?.legacy).toBe('node scripts/new.mjs');
  });

  it('does not mutate the previous-starter record either', () => {
    const before = JSON.stringify(previous);
    mergePackageJson(starter, brandWithCorpses, previous);
    expect(JSON.stringify(previous)).toBe(before);
  });
});

describe('package.json merge: against the real files', () => {
  const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as Pkg;
  const realStarter = read('../../../storefront-starter/package.json');
  const realBrand = read('../package.json');

  it('is idempotent down to key order — a re-sync writes a byte-identical file', () => {
    // Serialised, not `toEqual`: the first version of this test compared objects, which ignores key
    // order, and the first real sync duly reordered `lighthouse` to the starter's position. The file
    // on disk is what a reviewer sees in the diff, so the assertion has to be about the bytes.
    // If this fails, the committed package.json and the merge rules disagree and the next person to
    // run `pnpm sync` gets surprise churn.
    const merged = mergePackageJson(realStarter, realBrand);
    expect(`${JSON.stringify(merged, null, 2)}
`).toBe(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  });

  it('ships a starter manifest that is self-consistent and usable by the merge', () => {
    /**
     * Self-consistency ONLY. This deliberately does not compare against today's starter.
     *
     * The manifest is, by definition, the starter *as of the last sync* — so differing from the
     * starter's current `package.json` is a correct state, not drift. An earlier version asserted
     * equality of the merge-relevant key sets, which still made this a tripwire: this file runs in
     * the root `pnpm test` on every PR in the repository, so window 3 adding or removing a starter
     * dependency would have turned *their* branch red for a manifest that is doing its job.
     *
     * The freshness question is real but belongs to whoever runs the sync, not to everyone else's
     * CI: `node scripts/sync-from-starter.mjs --check` answers it on demand.
     */
    const manifest = read('../scripts/starter-manifest.json');

    expect(typeof manifest).toBe('object');
    expect(manifest.scripts, 'a manifest without scripts cannot detect a script deletion').toEqual(
      expect.any(Object),
    );
    expect(Object.keys(manifest.scripts ?? {}).length).toBeGreaterThan(0);
    // At least one dependency block, or dependency deletions are undetectable.
    const hasDeps = (['dependencies', 'devDependencies'] as const).some(
      (f) => manifest[f] !== undefined,
    );
    expect(hasDeps, 'a manifest with no dependency block cannot detect a dependency deletion').toBe(
      true,
    );
  });

  it('really does keep brand A on 3101 and carry every starter script', () => {
    const merged = mergePackageJson(realStarter, realBrand) as Pkg;
    expect(merged.name).toBe('@platform/storefront-brand-a');
    expect(merged.scripts?.dev).toContain('3101');
    for (const name of Object.keys(realStarter.scripts ?? {})) {
      expect(merged.scripts).toHaveProperty(name);
    }
  });
});
