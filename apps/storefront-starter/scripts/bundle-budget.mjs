#!/usr/bin/env node
/**
 * Bundle budget: first-load JavaScript per route, gzipped, against committed thresholds.
 *
 *   node scripts/bundle-budget.mjs            # check against bundle-budget.json, exit 1 on a breach
 *   node scripts/bundle-budget.mjs --report   # print every route, check nothing
 *
 * Reads the manifests `next build` writes, so it needs a build first and no running server.
 *
 * "First load" is what a visitor downloads before the route is interactive: the root main chunks
 * plus the chunks of the page **and every layout above it**, deduplicated, gzipped at level 9, with
 * polyfills excluded because modern browsers never fetch them.
 *
 * This deliberately reads **higher than the "First Load JS" column `next build` prints** — by
 * ~1.6 kB on every `[locale]` route today. Next counts only the page's own entry, which already
 * holds the shared chunks but not the layouts' entry chunks (`app/[locale]/layout-*.js`,
 * `app/[locale]/(shop)/layout-*.js`). The browser downloads those on first load all the same, so a
 * budget on Next's figure would under-count exactly the code a brand is most likely to grow: its
 * header and footer. Checked file by file against the manifests, not assumed.
 *
 * No dependency on purpose: size-limit and the bundle analyzer both answer a different question
 * (package entry points, or an interactive treemap), and the manifests already say exactly which
 * files each route loads.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nextDir = join(root, '.next');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Parent layouts of a page key, outermost first: `/a/(g)/b/page` → `/a/layout`, `/a/(g)/layout`, … */
export function layoutKeys(pageKey, available) {
  const segments = pageKey.split('/').filter(Boolean);
  segments.pop(); // `page`
  const keys = [];
  for (let i = 1; i <= segments.length; i += 1) {
    const key = `/${segments.slice(0, i).join('/')}/layout`;
    if (available.has(key)) keys.push(key);
  }
  return keys;
}

const gzipCache = new Map();
function gzipBytes(file) {
  if (!gzipCache.has(file)) {
    gzipCache.set(file, gzipSync(readFileSync(join(nextDir, file)), { level: 9 }).length);
  }
  return gzipCache.get(file);
}

export function firstLoadBytes(pageKey, appManifest, rootMainFiles) {
  const available = new Set(Object.keys(appManifest.pages));
  const files = new Set(rootMainFiles);
  for (const key of [...layoutKeys(pageKey, available), pageKey]) {
    for (const file of appManifest.pages[key] ?? []) files.add(file);
  }
  let total = 0;
  for (const file of files) if (file.endsWith('.js')) total += gzipBytes(file);
  return total;
}

function kb(bytes) {
  return Math.round((bytes / 1000) * 10) / 10;
}

function main() {
  const appManifestPath = join(nextDir, 'app-build-manifest.json');
  if (!existsSync(appManifestPath)) {
    console.error('bundle-budget: no build found — run `next build` first.');
    process.exit(2);
  }

  const appManifest = readJson(appManifestPath);
  const { rootMainFiles } = readJson(join(nextDir, 'build-manifest.json'));
  const pages = Object.keys(appManifest.pages).filter((key) => key.endsWith('/page'));

  if (process.argv.includes('--report')) {
    for (const key of pages.sort()) {
      console.log(
        `${String(kb(firstLoadBytes(key, appManifest, rootMainFiles))).padStart(7)} kB  ${key}`,
      );
    }
    return;
  }

  const budget = readJson(join(root, 'bundle-budget.json'));
  let failed = 0;
  for (const [route, limitKb] of Object.entries(budget.routes)) {
    if (!appManifest.pages[route]) {
      // A budgeted route that no longer exists is a stale budget, and a stale budget is a gate
      // that silently stopped checking anything.
      console.error(`✗ ${route} — not in this build; update bundle-budget.json`);
      failed += 1;
      continue;
    }
    const actual = kb(firstLoadBytes(route, appManifest, rootMainFiles));
    const ok = actual <= limitKb;
    console.log(`${ok ? '✓' : '✗'} ${route} — ${actual} kB (budget ${limitKb} kB)`);
    if (!ok) failed += 1;
  }

  if (failed > 0) {
    console.error(`bundle-budget: ${failed} route(s) over budget or missing.`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
