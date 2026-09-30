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
 *
 * EXCLUDED (never copied): the starter's Dockerfile (every Dockerfile is window 5's path — the
 * brand image arrives via a REQUEST issue), and its README/CHANGELOG/CLAUDE.md (this app has its
 * own).
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
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergePackageJson } from './merge-package-json.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const starterDir = path.resolve(appDir, '..', '..', 'storefront-starter');

const EXCLUDE = new Set(['Dockerfile', 'CLAUDE.md', 'README.md', 'CHANGELOG.md']);
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
  // TEMPORARY, while REQUEST #278 is open: the starter's copy asserts this brand's own override
  // files are empty, which is false by construction in a clone. Drop this line and re-sync once
  // window 3 has moved those starter-only assertions out.
  'test/slots.test.ts',
]);
const isPreserved = (file) => PRESERVE.has(file) || file.startsWith('src/brand/');

const tracked = execFileSync('git', ['-C', starterDir, 'ls-files'], { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
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

console.log(
  `sync-from-starter: ${copied} copied, ${merged} merged, ${preserved} preserved, ` +
    `${EXCLUDE.size} excluded (from ${tracked.length} tracked starter files)` +
    `${previousStarter === undefined ? '; no previous manifest, nothing treated as deleted' : ''}`,
);
