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

describe('package.json merge: against this app own committed files', () => {
  /**
   * Everything here reads only `apps/storefronts/brand-a/**`. That is the rule now, and it was
   * learned twice: a test in a brand app runs in the repo-wide `pnpm test`, so reading another
   * window's file makes their PR red for a change that is none of this app's business.
   *
   * The live starter is compared **only** by `node scripts/sync-from-starter.mjs --check`, which
   * the person syncing runs on purpose.
   */
  const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as Pkg;
  const manifest = read('../scripts/starter-manifest.json');
  const realBrand = read('../package.json');
  const SOURCE = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const serialise = (pkg: Pkg) => `${JSON.stringify(pkg, null, 2)}\n`;

  /**
   * The ONE thing the merge comparison below ignores: the version string of a dependency key that
   * **both** the manifest and this app declare (#758).
   *
   * **Why it has to be ignored.** Dependabot edits every `package.json` that declares a package and
   * never `scripts/starter-manifest.json`. The comparison passes the manifest as the *starter*, so
   * the merge rule "the starter's value wins for a shared key" reads the version out of the manifest
   * and then demands this app match it — a bump of `postcss` here is reverted by the merge and the
   * test fails. Every grouped Dependabot PR touching a starter package was red by construction
   * (#747, #755), which is why #757 had to **ignore 19 packages** in `.github/dependabot.yml`; that
   * ignore is workspace-wide, so those packages stopped getting routine bumps anywhere, and that is
   * how a CRITICAL `next` advisory came to sit in three brands until it was bumped by hand (#731).
   *
   * **Why it is safe to ignore.** `mergePackageJson` reads `previousStarter` only for key membership
   * (`key in previousStarter`) — it never reads a value out of it. The manifest's versions are
   * authoritative in no code path; they existed here and in `--check`'s drift report. The live
   * starter is the real authority, and `--check` is where it is enforced: keys **and** values, on
   * demand, by whoever is syncing. Deliberately not in anyone's CI — this file runs in the
   * repo-wide `pnpm test`, so a starter-side bump would otherwise redden window 3's PRs for a
   * manifest that is doing its job.
   *
   * Everything else stays byte-exact. The mutation table at the end of this block is the evidence,
   * not the claim.
   */
  const SYNCED = '<synced from the starter>';
  const maskSyncedVersions = (pkg: Pkg) => {
    const out = JSON.parse(JSON.stringify(pkg)) as Pkg;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
      const block = out[field] as Record<string, string> | undefined;
      const fromManifest = (manifest[field] ?? {}) as Record<string, string>;
      if (!block) continue;
      for (const key of Object.keys(block)) if (key in fromManifest) block[key] = SYNCED;
    }
    return serialise(out);
  };

  /** A dependency key this app and the manifest share — the kind Dependabot bumps. */
  const sharedDependency = () => {
    for (const field of ['devDependencies', 'dependencies'] as const) {
      const fromManifest = (manifest[field] ?? {}) as Record<string, string>;
      const key = Object.keys((realBrand[field] ?? {}) as object).find((k) => k in fromManifest);
      if (key !== undefined) return { field, key };
    }
    throw new Error('no dependency is shared with the manifest — the merge has nothing to govern');
  };

  /**
   * Are this app's synced dependency versions still the manifest's?
   *
   * True in the committed state, false while a Dependabot-shaped bump is in the working tree — and
   * the mutation table below has to behave differently in those two regimes, so it asks.
   */
  const syncedVersionsMatchManifest = () => {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
      const fromManifest = (manifest[field] ?? {}) as Record<string, string>;
      const mine = (realBrand[field] ?? {}) as Record<string, string>;
      for (const [key, value] of Object.entries(mine)) {
        if (key in fromManifest && fromManifest[key] !== value) return false;
      }
    }
    return true;
  };

  it('is committed in the exact shape a sync writes — two-space JSON, trailing newline', () => {
    // Split out from the merge assertion below (#758). Key order is what a reviewer sees in the
    // diff, and this is the half that checks it against the bytes on disk rather than against the
    // merge rules.
    expect(SOURCE).toBe(serialise(realBrand));
  });

  it('agrees with the merge rules — re-merging from the manifest reproduces it', () => {
    // Merged from the COMMITTED manifest, not from today's starter: the manifest is what the last
    // sync actually merged, so this asserts the committed package.json and the merge rules agree,
    // which is the real invariant. Comparing against the live starter made this a tripwire — a
    // window-3 script add or a vitest bump turned it red while `--check` said "manifest is current".
    const merged = mergePackageJson(manifest, realBrand, manifest);
    expect(maskSyncedVersions(merged)).toBe(maskSyncedVersions(realBrand));
  });

  it('accepts a Dependabot-shaped bump of a synced dependency (#758)', () => {
    // The whole point of the narrowing, as a test rather than a claim. Dependabot bumps this app's
    // package.json and leaves the manifest alone; the merge reverts the version to the manifest's,
    // and the old byte-exact comparison failed on exactly that difference.
    const { field, key } = sharedDependency();
    const bumped = JSON.parse(JSON.stringify(realBrand)) as Pkg;
    (bumped[field] as Record<string, string>)[key] = '^99.98.97';

    const merged = mergePackageJson(manifest, bumped, manifest) as Pkg;
    expect((merged[field] as Record<string, string>)[key], 'the merge reverts it').toBe(
      (manifest[field] as Record<string, string>)[key],
    );
    expect(serialise(merged), 'which is what used to fail').not.toBe(serialise(bumped));
    expect(maskSyncedVersions(merged), 'and is now accepted').toBe(maskSyncedVersions(bumped));
  });

  /**
   * What the narrowing must still catch — and what it was never going to.
   *
   * Each row is checked twice: against the narrowed comparison and against the byte-exact one it
   * replaced. Asserting the two agree is the load-bearing part: it proves a row that slips through
   * is a property of the merge rules, not a hole this change opened.
   */
  const MUTATIONS: {
    name: string;
    mutate: (pkg: Pkg) => void;
    caught: boolean;
    because?: string;
  }[] = [
    {
      name: 'a synced dependency dropped from this app',
      mutate: (pkg) =>
        delete (pkg.devDependencies as Record<string, string>)[sharedDependency().key],
      caught: true,
    },
    {
      name: 'a changed body for a synced script',
      mutate: (pkg) => ((pkg.scripts as Record<string, string>).build = 'echo not the build'),
      caught: true,
    },
    {
      name: 'a reordered dependency block',
      mutate: (pkg) => {
        const block = pkg.devDependencies as Record<string, string>;
        pkg.devDependencies = Object.fromEntries(Object.entries(block).reverse());
      },
      caught: true,
    },
    {
      name: 'a dependency added by hand',
      mutate: (pkg) =>
        ((pkg.devDependencies as Record<string, string>)['zz-added-by-hand'] = '^1.0.0'),
      caught: false,
      because:
        'the merge keeps a key only this app declares, because a brand legitimately adds its own',
    },
    {
      name: "this app's dev port edited to the starter's",
      mutate: (pkg) => ((pkg.scripts as Record<string, string>).dev = 'next dev --port 3100'),
      caught: false,
      because:
        '`dev` is identity, so the merge takes this app value whatever it says — the port is ' +
        'asserted directly in the next test',
    },
  ];

  it.each(MUTATIONS)('$name', ({ mutate, caught, because }) => {
    const mutated = JSON.parse(JSON.stringify(realBrand)) as Pkg;
    mutate(mutated);
    const merged = mergePackageJson(manifest, mutated, manifest);

    const narrowed = maskSyncedVersions(merged) !== maskSyncedVersions(mutated);
    const byteExact = serialise(merged) !== serialise(mutated);
    expect(narrowed, because ?? 'the narrowed comparison must still notice this').toBe(caught);

    if (syncedVersionsMatchManifest()) {
      // The committed state. Here the two comparisons are equivalent, which is the evidence that a
      // row slipping through is a property of the merge rules and not a hole #758 opened.
      expect(narrowed, 'with versions in step, the narrowed and byte-exact comparisons agree').toBe(
        byteExact,
      );
    } else {
      // A bump is sitting in the tree — what a Dependabot PR looks like, and what the simulation
      // in #758's PR puts here on purpose. Now the byte-exact comparison differs for EVERY row,
      // because the reverted version alone is enough: that is the construction that made those PRs
      // red, and it is the only difference between the two comparisons.
      expect(byteExact, 'a bump alone makes the byte-exact comparison differ').toBe(true);
    }
  });

  it('keeps brand A on 3101 and carries every script the manifest records', () => {
    const merged = mergePackageJson(manifest, realBrand, manifest) as Pkg;
    expect(merged.name).toBe('@platform/storefront-brand-a');
    expect(merged.scripts?.dev).toContain('3101');
    for (const name of Object.keys(manifest.scripts ?? {})) {
      expect(merged.scripts, `${name} was dropped`).toHaveProperty(name);
    }
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
});
