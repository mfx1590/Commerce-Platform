import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localeConfigFromEnv } from '../src/i18n/locale-config.mjs';

/**
 * Brand C's own locale, checked against the file that has to exist for it — the one test in this
 * app that is **not** written in whatever locale vitest happens to be configured with.
 *
 * ## Why this file exists rather than the starter's `test/i18n.test.ts` doing the job
 *
 * Since #441 part 5 the starter's version derives its expected catalogue set from the **configured**
 * locales, which is right. But vitest never loads `next.config.mjs`, so the configured locales in a
 * unit run are whatever `SUPPORTED_LOCALES` is in the environment — and the starter's
 * `vitest.config.ts` defaults that to the starter's own `en-GB,de-DE`. So in brand C's unit suite
 * the starter's test checks that `en-GB.json` and `de-DE.json` exist, which they do (both are
 * synced), and **says nothing about `en-US.json`** — the file brand C actually needs.
 *
 * Setting `SUPPORTED_LOCALES=en-US` for vitest would fix that and break four synced tests that still
 * hard-code `en-GB` in their expectations (`test/route-origin.test.ts` ×2, `test/seo.test.ts`,
 * `test/cms-content.test.ts` — the app is right in every case, the test is written in the starter's
 * locale). Preserving those three files to correct four assertions would cost brand C 62 synced
 * tests' worth of future starter improvements. So the environment stays the starter's, a REQUEST
 * asks window 3 to make those four locale-generic, and the coverage that matters lives here, in a
 * file this brand owns and no sync will touch.
 *
 * This is the same move brand B made for its funnel coverage in #437: when an inherited test cannot
 * express a brand's reality, move the assertion into the brand rather than delete it.
 *
 * What it is worth: `src/i18n/request.ts` imports `messages/<locale>.json` **unguarded**, so a
 * missing catalogue is not a missing-string problem — `next build` fails outright with
 * `Cannot find module './en-US.json'`, measured on 2026-10-09. See `ONBOARDING-GAPS.md` § 3.14.
 */

const APP = join(import.meta.dirname, '..');

/** The locales this brand really declares — from `next.config.mjs`, where a brand states them. */
function declaredLocales(): string[] {
  const config = readFileSync(join(APP, 'next.config.mjs'), 'utf8');
  const declared = /SUPPORTED_LOCALES\s*\?\?=\s*'([^']+)'/.exec(config)?.[1];
  expect(declared, 'next.config.mjs must declare SUPPORTED_LOCALES').toBeDefined();
  return localeConfigFromEnv({ SUPPORTED_LOCALES: declared }).locales;
}

describe("brand C's own locale", () => {
  it('is declared in next.config.mjs, which is what the running app reads', () => {
    expect(declaredLocales()).toEqual(['en-US']);
  });

  it('has a message catalogue, without which next build fails outright', () => {
    const catalogues = readdirSync(join(APP, 'messages')).filter((f) => f.endsWith('.json'));
    for (const locale of declaredLocales()) {
      expect(catalogues, `messages/${locale}.json is missing — every page would throw`).toContain(
        `${locale}.json`,
      );
    }
  });

  it('matches the store the seed gives this brand, so the app and the store cannot disagree', () => {
    // The generated-brand trap worth one assertion: an app declaring a locale its store does not
    // offer renders a correct 404 on every page, because `assertStoreOffersLocale` fails closed.
    const seed = readFileSync(join(APP, '..', '..', '..', 'packages/db/src/seed/index.ts'), 'utf8');
    const brandC = seed.slice(seed.indexOf("code: 'brand-c'"));
    const locales = /locales:\s*\[([^\]]+)\]/.exec(brandC)?.[1];
    expect(locales, 'the seed must give brand-c a locales list').toBeDefined();
    const seeded = locales!.split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(seeded).toEqual(declaredLocales());
  });

  it('has the same keys in its catalogue as the locale it was copied from', () => {
    // en-US was copied from the starter's en-GB and two spellings changed; a key added to one and
    // not the other renders the key name to a customer.
    const keysOf = (file: string): string[] => {
      const walk = (value: unknown, prefix = ''): string[] =>
        typeof value !== 'object' || value === null
          ? [prefix]
          : Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
              walk(v, prefix === '' ? k : `${prefix}.${k}`),
            );
      return walk(JSON.parse(readFileSync(join(APP, 'messages', file), 'utf8'))).sort();
    };
    expect(keysOf('en-US.json')).toEqual(keysOf('en-GB.json'));
  });
});
