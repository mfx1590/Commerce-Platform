#!/usr/bin/env node
/**
 * Create a new brand storefront from an existing one (#438).
 *
 *   node apps/storefronts/scripts/new-brand.mjs brand-c \
 *     --name "Brand C" --currency USD --locale en-US --port 3103 --jurisdiction US
 *
 * Add `--dry-run` to print the plan and write nothing.
 *
 * ## What this does, and what it deliberately will not
 *
 * The specification is `apps/storefronts/brand-b/ONBOARDING-GAPS.md`, written while brand B was
 * created by hand (#437). It drew the line this script keeps:
 *
 * - **§ 1 mechanical** — the clone, the path depths, the ports, the identity files, the content
 *   skeleton. That is what runs below.
 * - **§ 2 decisions** — the name, the locale list and above all the **legal jurisdiction**. Those
 *   are required arguments; `parseArgs` refuses without them rather than defaulting. A generator
 *   can supply the four legal documents' structure and placeholder names, never their law.
 * - **§ 6 not ours** — the store, legal entity, publishable key and Keycloak client. Since
 *   2026-10-08 a store is created with `onboardStore` through the admin onboarding wizard (#428).
 *   This script **points at the wizard**; doing it here would duplicate it and bypass its
 *   permission checks.
 *
 * **It derives from an existing BRAND, not the starter** (default `--template brand-b`). The brand
 * copies carry fixes the starter does not: `numberOfRuns: 5` (#348), the `STORE_PUBLISHABLE_KEY ??=`
 * line in `playwright.config.ts` (#382), platform-keyed snapshots, and the refusal to import
 * `RUNTIME_SITE_URL` (#379). Seeding from the starter would reproduce three solved bugs.
 *
 * **A second run refuses rather than overwriting.** A generator that clobbers a brand someone has
 * since edited is worse than no generator.
 *
 * The rules live in `new-brand-plan.mjs`, which touches no filesystem and is unit-tested
 * (`apps/storefronts/brand-b/test/new-brand-plan.test.ts`) — the arrangement
 * `merge-package-json.mjs` uses for the sync's merge rules.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NewBrandError,
  TEMPLATE_FILES,
  devPublishableKey,
  e2eExclusions,
  manualSteps,
  messageCatalogues,
  parseArgs,
  rewrite,
  runtimeDefaults,
  substitutions,
} from './new-brand-plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const storefronts = path.resolve(here, '..');
const repo = path.resolve(storefronts, '..', '..');

const log = (message) => console.log(message);
const step = (message) => console.log(`\n── ${message}`);

function readTemplateMeta(templateDir, templateCode) {
  const pkg = JSON.parse(readFileSync(path.join(templateDir, 'package.json'), 'utf8'));
  const dev = pkg.scripts?.dev ?? '';
  const port = Number(/--port\s+(\d+)/.exec(dev)?.[1]);
  if (!Number.isInteger(port)) {
    throw new NewBrandError(
      `cannot read the template's dev port from ${templateCode}/package.json scripts.dev ("${dev}")`,
    );
  }
  const config = readFileSync(path.join(templateDir, 'src/brand/config.ts'), 'utf8');
  const name = /name:\s*'([^']+)'/.exec(config)?.[1];
  if (name === undefined) {
    throw new NewBrandError(
      `cannot read the template's brand name from ${templateCode}/src/brand/config.ts`,
    );
  }
  // The template's locales, from the runtime default `runtimeDefaults()` writes into every brand's
  // next.config.mjs. `substitutions()` needs them to rewrite the locale literals the template
  // carries (its lighthouse collect URLs, its own prose); a template that does not declare them is
  // a template whose URL space is unknown, so refuse rather than assume the starter's.
  const nextConfig = readFileSync(path.join(templateDir, 'next.config.mjs'), 'utf8');
  const declared = /SUPPORTED_LOCALES\s*\?\?=\s*'([^']+)'/.exec(nextConfig)?.[1];
  if (declared === undefined) {
    throw new NewBrandError(
      `cannot read the template's locales from ${templateCode}/next.config.mjs: no ` +
        "`process.env.SUPPORTED_LOCALES ??= '…'`. Brand B has one (#437); a template without it " +
        'inherits the starter’s two and there is no single locale to rewrite from.',
    );
  }
  const locales = declared
    .split(',')
    .map((locale) => locale.trim())
    .filter((locale) => locale !== '');
  return { code: templateCode, name, port, locales };
}

function main() {
  const target = parseArgs(process.argv.slice(2));
  const appDir = path.join(storefronts, target.code);
  const cmsDir = path.join(repo, 'cms', target.code);
  const templateDir = path.join(storefronts, target.template);
  const templateCmsDir = path.join(repo, 'cms', target.template);

  if (!existsSync(templateDir)) {
    throw new NewBrandError(
      `template brand "${target.template}" is not at apps/storefronts/${target.template}. ` +
        'Derive from an existing BRAND, not the starter: the brand copies carry fixes the starter ' +
        'does not (ONBOARDING-GAPS.md section 1).',
    );
  }
  // The refusal that matters: never overwrite a brand someone has since edited.
  for (const existing of [appDir, cmsDir]) {
    if (existsSync(existing)) {
      throw new NewBrandError(
        `${path.relative(repo, existing)} already exists. Delete it first if you really mean to ` +
          'start over — this script will not overwrite a brand.',
      );
    }
  }

  const template = readTemplateMeta(templateDir, target.template);
  // Pairs are computed PER FILE: a locale literal is data in `lighthouserc.json` and prose
  // everywhere else (`LOCALE_DATA_FILES`). `pairs` is the file-independent set.
  const pairs = substitutions(template, target);
  const pairsFor = (file) => substitutions(template, target, file);

  log(`new-brand: ${target.code} from ${template.code} (${template.name}, :${template.port})`);
  log(`  name         ${target.name}`);
  log(`  currency     ${target.currency}`);
  log(`  locales      ${target.locales.join(', ')}`);
  log(`  port         ${target.port}`);
  log(`  jurisdiction ${target.jurisdiction}`);
  log(`  key          ${devPublishableKey(target.code)} (seed dev key, local databases only)`);
  if (target.dryRun) log('\n  --dry-run: nothing will be written');

  const write = (file, text) => {
    const full = path.join(appDir, file);
    if (target.dryRun) {
      log(`  would write ${path.relative(repo, full)}`);
      return;
    }
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
    log(`  ${path.relative(repo, full)}`);
  };

  // 1. The clone. The sync script is the brand's own copy, so it resolves the starter relative to
  //    itself; a first run needs no flag (MERGE and PRESERVE fall through to a plain copy).
  step('clone from the starter');
  if (target.dryRun) {
    log('  would copy the three sync scripts and run sync-from-starter.mjs');
  } else {
    mkdirSync(path.join(appDir, 'scripts'), { recursive: true });
    for (const script of [
      'sync-from-starter.mjs',
      'merge-package-json.mjs',
      'preserved-drift.mjs',
    ]) {
      copyFileSync(path.join(templateDir, 'scripts', script), path.join(appDir, 'scripts', script));
    }
    // NOT starter-manifest.json or starter-preserved.json: those are the TEMPLATE's records, and a
    // first sync that read them would think the starter had moved (ONBOARDING-GAPS.md section 1).
    log(
      execFileSync(process.execPath, ['scripts/sync-from-starter.mjs'], {
        cwd: appDir,
        encoding: 'utf8',
      }).trim(),
    );
  }

  // 2. The files that come from the template brand rather than the starter.
  step('identity from the template brand');
  for (const file of TEMPLATE_FILES.verbatim) {
    const from = path.join(templateDir, file);
    if (!existsSync(from)) continue;
    write(file, readFileSync(from, 'utf8'));
  }
  for (const file of TEMPLATE_FILES.substituted) {
    const from = path.join(templateDir, file);
    if (!existsSync(from)) continue;
    write(file, rewrite(readFileSync(from, 'utf8'), pairsFor(file)));
  }

  // 3. The runtime defaults. Without KEYCLOAK_CLIENT_ID the brand signs its customers in through
  //    brand A's client and mints sessions scoped to brand-a (#441 part 2).
  step('runtime defaults in next.config.mjs');
  const defaults = runtimeDefaults(target);
  for (const { name, value } of defaults) log(`  ${name} = ${value}`);
  if (!target.dryRun) {
    const configPath = path.join(appDir, 'next.config.mjs');
    let config = readFileSync(configPath, 'utf8');
    for (const { name, value } of defaults) {
      const line = `process.env.${name} ??= '${value}';`;
      if (!config.includes(`process.env.${name} ??=`)) {
        config = `${line}\n\n${config}`;
      } else {
        config = config.replace(new RegExp(`process\\.env\\.${name} \\?\\?= '[^']*';`), line);
      }
    }
    writeFileSync(configPath, config);
  }

  // 3b. The UI message catalogue. Not cosmetic: `src/i18n/request.ts` imports
  //     `messages/${locale}.json` UNGUARDED, so a brand with no catalogue for its own locale
  //     throws on every page. See `messageCatalogues`.
  const catalogues = messageCatalogues(target);
  if (catalogues.length > 0) {
    step('UI message catalogue for a locale the starter does not ship');
    for (const catalogue of catalogues) {
      log(`  ${catalogue.file} from ${catalogue.basedOn}`);
      if (catalogue.needsTranslation)
        log('    UNTRANSLATED — every string is a copy, not a translation');
      if (target.dryRun) continue;
      const from = path.join(appDir, catalogue.basedOn);
      const to = path.join(appDir, catalogue.file);
      if (!existsSync(from)) {
        throw new NewBrandError(
          `cannot write ${catalogue.file}: its base ${catalogue.basedOn} is not in the starter ` +
            'clone. The starter locales `STARTER_LOCALES` names are out of date.',
        );
      }
      if (!existsSync(to)) copyFileSync(from, to);
    }
  }

  // 4. The e2e exclusions, emitted here so #441 has ONE place to undo rather than a brand each.
  step('e2e exclusions while #441 is open');
  const exclusions = e2eExclusions(target);
  if (exclusions.localePlural) {
    log(`  locale-plural specs: ${exclusions.localePlural.specs.join(', ')}`);
    log(`    ${exclusions.localePlural.reason}`);
  } else {
    log('  locale-plural: not needed (this brand sells the starter’s locales)');
  }
  log(`  foreign-market tests: ${exclusions.foreignMarket.tests.length}`);
  log(`    ${exclusions.foreignMarket.reason}`);
  log('  (already present in the template’s playwright.config.ts, carried by substitution)');

  // 5. The content skeleton. Structure only: every sentence is a decision (section 2).
  step('cms content skeleton');
  if (target.dryRun) {
    log(`  would create cms/${target.code}/{content,media,scripts}`);
  } else {
    mkdirSync(path.join(cmsDir, 'content'), { recursive: true });
    mkdirSync(path.join(cmsDir, 'media'), { recursive: true });
    mkdirSync(path.join(cmsDir, 'scripts'), { recursive: true });
    for (const script of TEMPLATE_FILES.cmsScripts) {
      const from = path.join(templateCmsDir, 'scripts', script);
      if (!existsSync(from)) continue;
      writeFileSync(
        path.join(cmsDir, 'scripts', script),
        rewrite(readFileSync(from, 'utf8'), pairs),
      );
    }
    // The document SET, with placeholders. The set mirrors; the prose does not.
    const locale = target.locales[0];
    const skeleton = {
      'home.json': [
        {
          _id: `page.${locale}.home`,
          _type: 'page',
          locale,
          title: `[[BRAND_NAME]]`,
          slug: { _type: 'slug', current: 'home' },
          hero: {
            _type: 'hero',
            headline: '[[HOME_HEADLINE]]',
            subheadline: '[[HOME_SUBHEADLINE]]',
            layout: 'image-right',
          },
          blocks: [],
          seo: { metaTitle: '[[HOME_META_TITLE]]', metaDescription: '[[HOME_META_DESCRIPTION]]' },
        },
      ],
      'legal.json': ['imprint', 'privacy', 'terms', 'returns'].map((kind) => ({
        _id: `legal.${locale}.${kind}`,
        _type: 'legal',
        locale,
        title: `[[LEGAL_${kind.toUpperCase()}_TITLE]]`,
        slug: { _type: 'slug', current: kind },
        kind,
        lastReviewed: new Date().toISOString().slice(0, 10),
        body: {
          _type: 'richText',
          content: [
            {
              _type: 'block',
              _key: `${kind}-p`,
              style: 'normal',
              children: [
                {
                  _type: 'span',
                  _key: `${kind}-p-span`,
                  // The one thing a generator must never fake.
                  text:
                    `[[LEGAL_${kind.toUpperCase()}_BODY]] — written for ` +
                    `${target.jurisdiction} law by a lawyer, not by this script.`,
                },
              ],
            },
          ],
        },
      })),
    };
    for (const [file, docs] of Object.entries(skeleton)) {
      writeFileSync(path.join(cmsDir, 'content', file), `${JSON.stringify(docs, null, 2)}\n`);
      log(`  cms/${target.code}/content/${file}`);
    }
    writeFileSync(
      path.join(cmsDir, 'media', 'manifest.json'),
      `${JSON.stringify(
        {
          brand: target.code,
          source: `commerce-platform-media/${target.code}/manifest.json (outside the repo) — NOT YET GENERATED`,
          generator: `pending: ${target.code}'s stills have not been produced.`,
          licence: 'to be recorded when the media is generated',
          delivery:
            'Cloudinary: https://res.cloudinary.com/<cloud>/<image|video>/upload/<publicId>',
          // No bytes/sha256/width/height: the files do not exist, and a made-up digest would be a
          // false record (ONBOARDING-GAPS.md section 5).
          slots: [],
        },
        null,
        2,
      )}\n`,
    );
    log(
      `  cms/${target.code}/media/manifest.json (no slots yet, no digests — media not generated)`,
    );
  }

  // 6. What this script could not do.
  step('MANUAL — what this script cannot do');
  for (const { step: name, where, why } of manualSteps(target)) {
    log(`  • ${name}`);
    log(`      where: ${where}`);
    log(`      why:   ${why}`);
  }

  step('next');
  log(`  pnpm install                      # a NEW workspace package needs a non-frozen install`);
  log(`  pnpm --filter @platform/storefront-${target.code} typecheck`);
  log(`  pnpm --filter @platform/storefront-${target.code} test`);
  log(`  pnpm lint && pnpm format:check`);
  log('');
  log('  Read every generated file before believing it. This script does the mechanical half;');
  log('  apps/storefronts/brand-b/ONBOARDING-GAPS.md lists the twelve traps that are not.');
}

try {
  main();
} catch (error) {
  if (error instanceof NewBrandError) {
    console.error(`\nnew-brand: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
