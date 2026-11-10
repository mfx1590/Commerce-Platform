import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mergePackageJson } from '../scripts/merge-package-json.mjs';

/**
 * This app's `package.json` is GENERATED: `scripts/sync-from-starter.mjs` merges the starter's into
 * it (identity survives, everything else tracks the starter) and `scripts/starter-manifest.json`
 * records what the starter looked like at the last sync, so the merge can tell a key this app added
 * from one the starter deleted.
 *
 * **Why this file exists (#758).** Until now only brand A asserted that its committed
 * `package.json` and the merge rules agree — brands B and C carried the same generated file, the
 * same merge module and the same manifest with nothing checking any of it, so a hand edit here
 * would have been reverted by the next sync with no warning in between. The merge rules themselves
 * are unit-tested in brand A's copy of this file; this one is about **this app's own committed
 * files**.
 */

type Pkg = Record<string, unknown> & {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('package.json merge: against this app own committed files', () => {
  /**
   * Everything here reads only `apps/storefronts/brand-b/**`. That is the rule now, and it was
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

  /**
   * A plain semver range — `^8.5.6`, `~1.2.3`, `1.2.3`, `*` — and **not** a value that says where
   * the package comes from: `workspace:*`, `npm:alias@1.0.0`, `git+https://…`, `file:../x`, a
   * tarball URL. A protocol is the whole meaning of the dependency, so it is never masked.
   *
   * This guard is #789's review finding, and it was a real hole: masking a shared key's value
   * *whatever it was* meant `"@platform/cms": "workspace:*"` could be swapped for a git URL and the
   * assertion no longer noticed — where the byte-exact comparison it replaced did, and nothing else
   * in CI would.
   */
  const isPlainSemverRange = (value: string | undefined) =>
    value !== undefined && !value.includes(':') && !value.includes('/');

  const maskSyncedVersions = (pkg: Pkg) => {
    const out = JSON.parse(JSON.stringify(pkg)) as Pkg;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
      const block = out[field] as Record<string, string> | undefined;
      const fromManifest = (manifest[field] ?? {}) as Record<string, string>;
      if (!block) continue;
      for (const key of Object.keys(block)) {
        if (!(key in fromManifest)) continue;
        // Both sides, deliberately: a swap in either direction between a range and a protocol is
        // the kind of change this comparison has to keep catching.
        if (!isPlainSemverRange(block[key]) || !isPlainSemverRange(fromManifest[key])) continue;
        block[key] = SYNCED;
      }
    }
    return serialise(out);
  };

  /**
   * A dependency key this app and the manifest share **at a plain semver range** — the only kind
   * Dependabot bumps, and the only kind the masking applies to.
   */
  const sharedDependency = () => {
    for (const field of ['devDependencies', 'dependencies'] as const) {
      const fromManifest = (manifest[field] ?? {}) as Record<string, string>;
      const mine = (realBrand[field] ?? {}) as Record<string, string>;
      const key = Object.keys(mine).find(
        (k) =>
          k in fromManifest && isPlainSemverRange(mine[k]) && isPlainSemverRange(fromManifest[k]),
      );
      if (key !== undefined) return { field, key };
    }
    throw new Error('no dependency is shared with the manifest — the merge has nothing to govern');
  };

  /** A shared key pinned by PROTOCOL rather than by range — `workspace:*` here. */
  const sharedProtocolDependency = () => {
    for (const field of ['dependencies', 'devDependencies'] as const) {
      const fromManifest = (manifest[field] ?? {}) as Record<string, string>;
      const mine = (realBrand[field] ?? {}) as Record<string, string>;
      const key = Object.keys(mine).find((k) => k in fromManifest && !isPlainSemverRange(mine[k]));
      if (key !== undefined) return { field, key };
    }
    throw new Error('no shared dependency uses a protocol — the guard below has nothing to prove');
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
      // #789's review probe, as three rows. A shared key swapped from a range to a PROTOCOL
      // changes where the package comes from, which is not a version bump in any sense and is
      // exactly what the first version of the masking stopped catching.
      name: 'a shared dependency swapped for a git+https URL',
      mutate: (pkg) => {
        const { field, key } = sharedDependency();
        (pkg[field] as Record<string, string>)[key] = 'git+https://example.invalid/pkg.git#main';
      },
      caught: true,
    },
    {
      name: 'a shared dependency swapped for an npm: alias',
      mutate: (pkg) => {
        const { field, key } = sharedDependency();
        (pkg[field] as Record<string, string>)[key] = 'npm:some-other-package@1.0.0';
      },
      caught: true,
    },
    {
      name: 'a shared dependency swapped for a tarball URL',
      mutate: (pkg) => {
        const { field, key } = sharedDependency();
        (pkg[field] as Record<string, string>)[key] = 'https://example.invalid/pkg-1.0.0.tgz';
      },
      caught: true,
    },
    {
      // The other direction: a workspace package repointed at a registry range. The manifest's
      // side is the protocol here, which is why the guard checks both.
      name: 'a workspace: dependency repointed at a registry range',
      mutate: (pkg) => {
        const { field, key } = sharedProtocolDependency();
        (pkg[field] as Record<string, string>)[key] = '^1.0.0';
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

  it('keeps brand B on 3102 and carries every script the manifest records', () => {
    const merged = mergePackageJson(manifest, realBrand, manifest) as Pkg;
    expect(merged.name).toBe('@platform/storefront-brand-b');
    expect(merged.scripts?.dev).toContain('3102');
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
