#!/usr/bin/env node
/**
 * Clone / re-sync this brand app from `apps/storefront-starter` (ADR 0004).
 *
 * The starter is a template, not a dependency: this script copies its tracked files here, so the
 * git diff between the two apps is exactly the brand's identity. Run it again after the starter
 * gains a fix (take it by merging main first) — brand-owned files are never overwritten, so the
 * diff that appears afterwards is real drift to review, not noise.
 *
 *   node scripts/sync-from-starter.mjs           # from apps/storefronts/brand-a
 *   node scripts/sync-from-starter.mjs --check   # report drift, write nothing, exit 1 if stale
 *
 * EXCLUDED (never copied): the starter's Dockerfile (every Dockerfile is window 5's path — the
 * brand image arrives via a REQUEST issue), its README/CHANGELOG/CLAUDE.md (this app has its
 * own), and test/starter-defaults.test.ts — it asserts the starter ships no brand, so it only runs
 * where the package is the starter, but its static imports still evaluate `src/brand/tokens.ts`,
 * whose `next/font/local` call cannot run under vitest. Starter-only by definition.
 *
 * PRESERVED (copied only when missing, never overwritten): the brand-identity files listed in the
 * README's "diff against the starter" section — next.config.mjs, scripts/start.mjs,
 * playwright.config.ts, lighthouserc.json, and everything under src/brand/.
 *
 * MERGED: package.json. Preserve froze it, so starter scripts and dependency bumps never arrived —
 * brand A silently missed `perf` and `bundle-budget` for a whole task. See merge-package-json.mjs
 * for the rules: identity survives, everything else tracks the starter.
 *
 * The merge also needs to know what the starter looked like *last* time, or it cannot tell a key the
 * brand added from one the starter deleted. `scripts/starter-manifest.json` is that record: the
 * starter's own package.json as of the last sync, written at the end of every run and committed. It
 * is generated — never edit it by hand.
 *
 * PRESERVED files never receive starter fixes, so `scripts/starter-preserved.json` records the
 * starter's blob id for each one at every sync, and both the sync and `--check` list the preserved
 * files whose starter counterpart has changed since — those need porting by hand. See
 * preserved-drift.mjs.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergePackageJson } from './merge-package-json.mjs';
import { blobIds, preservedDrift } from './preserved-drift.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const starterDir = path.resolve(appDir, '..', '..', 'storefront-starter');

const EXCLUDE = new Set([
  'Dockerfile',
  'CLAUDE.md',
  'README.md',
  'CHANGELOG.md',
  'test/starter-defaults.test.ts',
]);
/** Merged rather than copied or preserved — see merge-package-json.mjs. */
const MERGE = new Set(['package.json']);

const PRESERVE = new Set([
  'next.config.mjs',
  'scripts/start.mjs',
  'playwright.config.ts',
  'lighthouserc.json',
  // Path-depth fixes: this app sits one directory deeper than the starter.
  'tsconfig.json',
  'tailwind.config.ts',
]);
const isPreserved = (file) => PRESERVE.has(file) || file.startsWith('src/brand/');

const tracked = execFileSync('git', ['-C', starterDir, 'ls-files'], { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const checkOnly = process.argv.includes('--check');
const writeJson = (file, value) =>
  writeFileSync(
    file,
    `${JSON.stringify(value, null, 2)}
`,
  );

/** The starter's package.json as of the last sync; absent on the first run, and that is handled. */
const manifestPath = path.join(appDir, 'scripts', 'starter-manifest.json');
const previousStarter = existsSync(manifestPath) ? readJson(manifestPath) : undefined;
const starterPackage = readJson(path.join(starterDir, 'package.json'));

/** The starter's blob id per preserved path as of the last sync, and today. */
const preservedRecordPath = path.join(appDir, 'scripts', 'starter-preserved.json');
const previousPreserved = existsSync(preservedRecordPath)
  ? readJson(preservedRecordPath)
  : undefined;
const currentPreserved = blobIds(
  execFileSync('git', ['-C', starterDir, 'ls-files', '-s'], { encoding: 'utf8' }),
  (file) => isPreserved(file) && !EXCLUDE.has(file),
);
const preservedReport = () => {
  if (previousPreserved === undefined) {
    return ['No record of the preserved files yet; this sync writes one.'];
  }
  const drift = preservedDrift(previousPreserved, currentPreserved);
  if (drift.length === 0) return [];
  return [
    `${drift.length} PRESERVED file(s) changed in the starter since the last sync — the sync does not`,
    'take them; diff each against the starter and port the fix by hand:',
    ...drift.map((entry) => `  ${entry}`),
  ];
};

/**
 * `--check`: is the committed manifest still an accurate record of the starter?
 *
 * This question used to live in `test/sync-merge.test.ts`, which runs in the repo-wide `pnpm test`
 * — so a starter dependency change by window 3 turned *their* PR red over a manifest that was
 * doing exactly its job. The manifest is the starter AS OF THE LAST SYNC; differing from today's
 * starter is a correct state and only matters to whoever is about to sync. So it is answered on
 * demand, by the person syncing, and nowhere else.
 */
if (checkOnly) {
  // Reported first and never decides the exit code: the person checking wants to see it, and it
  // stays true after the sync until someone ports the change.
  const preservedLines = preservedReport();
  if (preservedLines.length > 0) {
    console.log(['sync-from-starter --check:', ...preservedLines].join('\n'));
  }

  if (previousStarter === undefined) {
    console.log('sync-from-starter --check: no manifest yet; the next sync will write one.');
    process.exit(0);
  }

  // Keys AND values. This is the only place the live starter is compared at all — the unit tests
  // read nothing outside this app — so it has to be the thorough one: a version bump or a changed
  // script body is drift the next sync will take, and the person syncing wants to see it.
  const drift = [];
  for (const field of ['scripts', 'dependencies', 'devDependencies', 'peerDependencies']) {
    const before = previousStarter?.[field] ?? {};
    const after = starterPackage?.[field] ?? {};
    for (const key of Object.keys(after)) {
      if (!(key in before)) drift.push(`+ ${field}.${key}`);
      else if (before[key] !== after[key]) {
        drift.push(`~ ${field}.${key}: ${before[key]} -> ${after[key]}`);
      }
    }
    for (const key of Object.keys(before)) if (!(key in after)) drift.push(`- ${field}.${key}`);
  }

  if (drift.length === 0) {
    console.log('sync-from-starter --check: manifest is current.');
    process.exit(0);
  }
  const lines = [
    `sync-from-starter --check: the starter has moved since the last sync (${drift.length} key(s)).`,
    ...drift.map((entry) => `  ${entry}`),
    '',
    'Run the sync to take them; a "-" line will be dropped from this app.',
  ];
  console.log(lines.join('\n'));
  process.exit(1);
}

let copied = 0;
let preserved = 0;
let merged = 0;
for (const file of tracked) {
  if (EXCLUDE.has(file)) continue;
  const target = path.join(appDir, file);

  // A brand that has not been generated yet has no package.json to merge into, so the first run
  // falls through to a plain copy and the brand edits it afterwards.
  if (MERGE.has(file) && existsSync(target)) {
    writeJson(target, mergePackageJson(starterPackage, readJson(target), previousStarter));
    merged += 1;
    continue;
  }

  if (isPreserved(file) && existsSync(target)) {
    preserved += 1;
    continue;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(starterDir, file), target);
  copied += 1;
}

// Last, and only after a successful run: next time, this is what "the starter used to have" means.
writeJson(manifestPath, starterPackage);
const preservedLines = preservedReport();
writeJson(preservedRecordPath, currentPreserved);

console.log(
  `sync-from-starter: ${copied} copied, ${merged} merged, ${preserved} preserved, ` +
    `${EXCLUDE.size} excluded (from ${tracked.length} tracked starter files)` +
    `${previousStarter === undefined ? '; no previous manifest, nothing treated as deleted' : ''}`,
);
if (preservedLines.length > 0) console.log(preservedLines.join('\n'));
