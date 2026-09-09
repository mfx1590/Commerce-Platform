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
 * README's "diff against the starter" section — package.json, next.config.mjs, scripts/start.mjs,
 * playwright.config.ts, lighthouserc.json, and everything under src/brand/.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const starterDir = path.resolve(appDir, '..', '..', 'storefront-starter');

const EXCLUDE = new Set(['Dockerfile', 'CLAUDE.md', 'README.md', 'CHANGELOG.md']);
const PRESERVE = new Set([
  'package.json',
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

let copied = 0;
let preserved = 0;
for (const file of tracked) {
  if (EXCLUDE.has(file)) continue;
  const target = path.join(appDir, file);
  if (isPreserved(file) && existsSync(target)) {
    preserved += 1;
    continue;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(starterDir, file), target);
  copied += 1;
}

console.log(
  `sync-from-starter: ${copied} copied, ${preserved} preserved, ${EXCLUDE.size} excluded (from ${tracked.length} tracked starter files)`,
);
