import { describe, expect, it } from 'vitest';
import {
  BRAND_CODE,
  KNOWN_JURISDICTIONS,
  NewBrandError,
  STARTER_LOCALES,
  TEMPLATE_FILES,
  camelForm,
  devPublishableKey,
  e2eExclusions,
  LOCALE_DATA_FILES,
  SEEDED_BRANDS,
  localeMismatch,
  localePairs,
  localeProse,
  manualSteps,
  messageCatalogues,
  parseArgs,
  proseForms,
  rewrite,
  runtimeDefaults,
  substitutions,
} from '../scripts/new-brand-plan.mjs';
import { localeConfigFromEnv } from '../src/i18n/locale-config.mjs';

/**
 * `apps/storefronts/brand-b/scripts/new-brand-plan.mjs` — the rules behind `new-brand.mjs` (#438).
 *
 * It lives in brand B's suite because brand B is the generator's template, and the generator lives
 * there too: `apps/storefronts/*` must keep meaning "a storefront", because `infra/ci/changes.sh`
 * reduces every changed path under it to a storefront directory and the perf gate fails on one with
 * no `perf` script (#438 — `apps/storefronts/scripts` was reported as an unmeasurable storefront).
 * It is also outside this window's documented paths (`apps/storefronts/<brand>/**`); the same arrangement as `brand-media.test.ts`, which reaches into
 * `cms/brand-a/scripts/`. The module touches no filesystem, so these are ordinary unit tests.
 *
 * Note for whoever runs the generator: this test file is brand B's and is **not** copied into a new
 * brand. `TEMPLATE_FILES` names every file taken from the template, and this one is not on it.
 */

const ARGS = [
  'brand-c',
  '--name',
  'Brand C',
  '--currency',
  'usd',
  '--locale',
  'en-US',
  '--port',
  '3103',
  '--jurisdiction',
  'us',
];

describe('parseArgs — a generator that guesses is worse than one that stops', () => {
  it('reads a complete command line, normalising currency and jurisdiction', () => {
    expect(parseArgs(ARGS)).toEqual({
      code: 'brand-c',
      name: 'Brand C',
      currency: 'USD',
      locales: ['en-US'],
      port: 3103,
      jurisdiction: 'US',
      template: 'brand-b',
      dryRun: false,
    });
  });

  it('defaults the template to brand B, because the brands carry fixes the starter does not', () => {
    // #348's numberOfRuns: 5, #382's publishable-key line, #379's RUNTIME_SITE_URL refusal.
    expect(parseArgs(ARGS).template).toBe('brand-b');
    expect(parseArgs([...ARGS, '--template', 'brand-a']).template).toBe('brand-a');
  });

  it.each(['name', 'currency', 'locale', 'port', 'jurisdiction'])(
    'refuses to default --%s',
    (flag) => {
      const index = ARGS.indexOf(`--${flag}`);
      const without = [...ARGS.slice(0, index), ...ARGS.slice(index + 2)];
      expect(() => parseArgs(without)).toThrow(NewBrandError);
      expect(() => parseArgs(without)).toThrow(new RegExp(`--${flag} is required`));
    },
  );

  it('names ONBOARDING-GAPS when it refuses, so the reason is findable', () => {
    const index = ARGS.indexOf('--jurisdiction');
    expect(() => parseArgs([...ARGS.slice(0, index)])).toThrow(/ONBOARDING-GAPS\.md section 2/);
  });

  it.each([
    ['Brand-C', 'not a brand code'],
    ['brand_c', 'not a brand code'],
    ['-brand-c', 'not a brand code'],
    ['brand--c', 'not a brand code'],
  ])('refuses the brand code %s', (code, message) => {
    expect(() => parseArgs([code, ...ARGS.slice(1)])).toThrow(new RegExp(message));
  });

  it('refuses a currency, locale or port that is not one', () => {
    const swap = (flag: string, value: string) => {
      const i = ARGS.indexOf(`--${flag}`);
      return [...ARGS.slice(0, i + 1), value, ...ARGS.slice(i + 2)];
    };
    expect(() => parseArgs(swap('currency', 'dollars'))).toThrow(/ISO 4217/);
    expect(() => parseArgs(swap('locale', 'en_US'))).toThrow(/not a locale/);
    expect(() => parseArgs(swap('locale', 'en-US,en-US'))).toThrow(/repeats a locale/);
    expect(() => parseArgs(swap('port', '80'))).toThrow(/3000 to 65535/);
    expect(() => parseArgs(swap('port', '3103.5'))).toThrow(/whole number/);
    expect(() => parseArgs(swap('jurisdiction', 'USA'))).toThrow(/alpha-2/);
  });

  it('accepts several locales, and keeps their order', () => {
    const i = ARGS.indexOf('--locale');
    const two = [...ARGS.slice(0, i + 1), 'en-GB,de-DE', ...ARGS.slice(i + 2)];
    expect(parseArgs(two).locales).toEqual(['en-GB', 'de-DE']);
  });

  it('refuses a flag with no value rather than swallowing the next flag', () => {
    expect(() => parseArgs(['brand-c', '--name', '--currency', 'USD'])).toThrow(
      /--name needs a value/,
    );
  });
});

describe('substitutions', () => {
  const template = { code: 'brand-b', name: 'Stonecrop', port: 3102, locales: ['en-GB'] };
  const target = { code: 'brand-c', name: 'Brand C', port: 3103, locales: ['en-US'] };

  it('rewrites the publishable key WHOLE, not by rewriting the code inside it', () => {
    // The trap this ordering exists for: `brand-b` is a substring of `pk_brand-b_dev_…`, so a
    // shorter pattern applied first would edit the key twice and the result would depend on
    // iteration order.
    const pairs = substitutions(template, target);
    const text = `key = '${devPublishableKey('brand-b')}';`;
    expect(rewrite(text, pairs)).toBe(`key = '${devPublishableKey('brand-c')}';`);
  });

  it('orders every pair longest-source-first', () => {
    const lengths = substitutions(template, target).map(([from]) => from.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });

  it('rewrites the package name, the Keycloak client, the cms path, the port and the brand name', () => {
    const pairs = substitutions(template, target);
    expect(rewrite('"@platform/storefront-brand-b"', pairs)).toBe('"@platform/storefront-brand-c"');
    expect(rewrite("'storefront-brand-b'", pairs)).toBe("'storefront-brand-c'");
    expect(rewrite('../../../cms/brand-b/content', pairs)).toBe('../../../cms/brand-c/content');
    expect(rewrite('--port 3102', pairs)).toBe('--port 3103');
    expect(rewrite("name: 'Stonecrop',", pairs)).toBe("name: 'Brand C',");
  });

  it('leaves nothing of the template behind in a realistic config', () => {
    const config = [
      "process.env.STORE_PUBLISHABLE_KEY ??= '" + devPublishableKey('brand-b') + "';",
      "process.env.KEYCLOAK_CLIENT_ID ??= 'storefront-brand-b';",
      "const APP_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3102';",
    ].join('\n');
    const out = rewrite(config, substitutions(template, target));
    expect(out).not.toContain('brand-b');
    expect(out).not.toContain('3102');
    expect(out).toContain(devPublishableKey('brand-c'));
  });

  it('rewrites the PROSE form too, not only the code', () => {
    // How this was found: brand C's generated launch gate reported "brand B still has 13
    // placeholders". The code was right and the sentences were not.
    const pairs = substitutions(template, target);
    expect(rewrite('brand B still has 13 placeholders', pairs)).toBe(
      'brand C still has 13 placeholders',
    );
    expect(rewrite("Brand B's legal content", pairs)).toBe("Brand C's legal content");
    expect(rewrite('cms/brand-b/content', pairs)).toBe('cms/brand-c/content');
  });

  it('has no prose form for a code that is not brand-<letter>', () => {
    expect(proseForms('acme')).toEqual([]);
    expect(proseForms('brand-ab')).toEqual([]);
    expect(proseForms('brand-c')).toEqual(['brand C', 'Brand C']);
  });

  it('drops a pair whose source and target are identical', () => {
    const same = substitutions(template, { ...target, name: 'Stonecrop' });
    expect(same.some(([from]) => from === 'Stonecrop')).toBe(false);
  });
});

describe('runtimeDefaults — the two levers brand A never needed', () => {
  it('emits the publishable key, the locale list and the brand OWN Keycloak client', () => {
    const defaults = runtimeDefaults({ code: 'brand-c', locales: ['en-US'] });
    expect(defaults).toEqual([
      { name: 'STORE_PUBLISHABLE_KEY', value: devPublishableKey('brand-c') },
      { name: 'SUPPORTED_LOCALES', value: 'en-US' },
      { name: 'KEYCLOAK_CLIENT_ID', value: 'storefront-brand-c' },
    ]);
  });

  it('never leaves KEYCLOAK_CLIENT_ID to the starter default', () => {
    // The starter falls back to 'storefront-brand-a'. A brand that inherits it mints customer
    // sessions scoped to brand-a, because store_code is stamped per client (#437, #441 part 2).
    const emitted = runtimeDefaults({ code: 'brand-c', locales: ['en-US'] });
    const client = emitted.find((entry) => entry.name === 'KEYCLOAK_CLIENT_ID');
    expect(client?.value).toBe('storefront-brand-c');
    expect(client?.value).not.toContain('brand-a');
  });

  it('joins a multi-locale list the way routing.ts parses it', () => {
    expect(
      runtimeDefaults({ code: 'brand-d', locales: ['en-GB', 'de-DE'] }).find(
        (e) => e.name === 'SUPPORTED_LOCALES',
      )?.value,
    ).toBe('en-GB,de-DE');
  });
});

describe('e2eExclusions — emitted by the script so #441 has one place to undo', () => {
  it('excludes the locale-plural specs only for a single-locale brand', () => {
    expect(e2eExclusions({ locales: ['en-US'] }).localePlural).not.toBeNull();
    expect(e2eExclusions({ locales: ['en-GB', 'de-DE'] }).localePlural).toBeNull();
  });

  it('says plainly that the locale-plural exclusion LOSES coverage', () => {
    const reason = e2eExclusions({ locales: ['en-US'] }).localePlural?.reason ?? '';
    expect(reason).toMatch(/loses the <head> metadata assertion/);
    expect(reason).toMatch(/#441/);
  });

  it('always excludes the four NL-address tests, and says there are four', () => {
    const foreign = e2eExclusions({ locales: ['en-US'] }).foreignMarket;
    expect(foreign.tests).toHaveLength(4);
    expect(foreign.tests).toContain('a stale session still buys');
    expect(foreign.reason).toMatch(/FOUR, not three/);
    expect(foreign.reason).toMatch(/coverage moves rather than disappears/);
  });
});

describe('manualSteps — what the script could not do', () => {
  // `locales` is part of every plan object (`parseArgs` always sets it) and `manualSteps` reads it
  // for the message-catalogue steps.
  const target = { code: 'brand-c', name: 'Brand C', jurisdiction: 'US', locales: ['en-US'] };

  it('names the brand name, the theme, the prose, the legals, the media and the store', () => {
    const steps = manualSteps(target)
      .map((s) => s.step)
      .join(' | ');
    expect(steps).toMatch(/brand name/);
    expect(steps).toMatch(/theme tokens/);
    expect(steps).toMatch(/content prose/);
    expect(steps).toMatch(/legal documents/);
    expect(steps).toMatch(/bytes\/sha256/);
    expect(steps).toMatch(/store, legal entity/);
  });

  it('points the store step at the onboarding wizard, never at itself', () => {
    // For a brand with no seeded store. brand-a/b/c already have one, and this step says so
    // instead — see "the seeded brands" below. The invariant either way: the script never
    // creates a store itself.
    const store = manualSteps({ ...target, code: 'brand-d' }).find((s) =>
      s.step.includes('store, legal entity'),
    );
    expect(store?.where).toMatch(/onboarding wizard/);
    expect(store?.why).toMatch(/bypass its permission checks/);
  });

  it('for a jurisdiction already written, cites the instruments and the brand to copy from', () => {
    const gb = manualSteps({ ...target, jurisdiction: 'GB' }).find((s) =>
      s.step.includes('legal documents'),
    );
    expect(gb?.why).toContain('Consumer Rights Act 2015');
    expect(gb?.why).toContain(KNOWN_JURISDICTIONS.GB.reference);
    expect(gb?.why).toMatch(/[Ss]till needs a lawyer/);
  });

  it('for an unwritten jurisdiction, admits it does not know the law', () => {
    // US used to be the example here. #438 wrote brand C's US drafts, so US is now KNOWN and the
    // honest example is a jurisdiction nobody has written: the point of the test is that the
    // script never invents instruments, not that any particular country is missing.
    const jp = manualSteps({ ...target, jurisdiction: 'JP' }).find((s) =>
      s.step.includes('legal documents'),
    );
    expect(jp?.why).toMatch(/no brand has been written for JP yet/);
    expect(jp?.why).toMatch(/from scratch/);
    // It must not invent instruments it has never been given.
    expect(jp?.why).not.toMatch(/Act \d{4}/);
    expect(jp?.why).not.toMatch(/UCC|CCPA|GDPR/);
  });

  it('for US, cites brand C and the fact that makes US different', () => {
    const us = manualSteps(target).find((s) => s.step.includes('legal documents'));
    expect(us?.why).toContain('cms/brand-c/content/legal.json');
    // The trap a brand porting A's or B's returns document would fall into: promising a statutory
    // cancellation right that does not exist in the US.
    expect(us?.why).toMatch(/Cooling-Off Rule, which does not cover online sales/);
    expect(us?.why).toMatch(/Still needs a lawyer/);
  });
});

describe('TEMPLATE_FILES', () => {
  it('takes lighthouserc.json from the template, not the starter', () => {
    // The starter is still numberOfRuns: 3. Copying it would re-introduce #348's flaky gate.
    // It is in `substituted` rather than `verbatim` because its collect URLs carry the locale —
    // see "the lighthouse config's locale" below. Either list means "from the template".
    expect([...TEMPLATE_FILES.verbatim, ...TEMPLATE_FILES.substituted]).toContain(
      'lighthouserc.json',
    );
  });

  it('substitutes the files that carry a port, a key or a package name', () => {
    for (const file of [
      'package.json',
      'next.config.mjs',
      'playwright.config.ts',
      'scripts/start.mjs',
    ]) {
      expect(TEMPLATE_FILES.substituted).toContain(file);
    }
  });

  it('does not carry the template brand own extra tests into a new brand', () => {
    const all = [...TEMPLATE_FILES.verbatim, ...TEMPLATE_FILES.substituted];
    expect(all).not.toContain('test/new-brand-plan.test.ts');
    expect(all).not.toContain('e2e/journey.spec.ts');
    // The launch gate IS taken, because every brand needs one and it is purely path-substituted.
    expect(TEMPLATE_FILES.substituted).toContain('test/launch-gate.test.ts');
  });
});

describe('the brand code pattern', () => {
  it.each(['brand-a', 'brand-c', 'acme', 'acme-eu-2'])('accepts %s', (code) => {
    expect(BRAND_CODE.test(code)).toBe(true);
  });

  it.each(['Brand-A', 'brand_a', 'brand-', '-brand', 'brand--a', ''])('refuses %s', (code) => {
    expect(BRAND_CODE.test(code)).toBe(false);
  });
});

describe('camelForm', () => {
  it('matches how SEED_IDS spells a brand, so prose citing a seed id is rewritten too', () => {
    // The bug this fixes: brand C's generated next.config.mjs cited
    // `SEED_IDS.publishableKeys.brandB` -- brand B's store -- because the table knew only
    // `brand-b` and `brand B`.
    expect(camelForm('brand-b')).toBe('brandB');
    expect(camelForm('brand-c')).toBe('brandC');
  });

  it('is null for a code it cannot spell, rather than guessing one', () => {
    expect(camelForm('storefront-starter')).toBeNull();
  });

  it('is applied AFTER the hyphenated code, which is longer', () => {
    const pairs = substitutions(
      { code: 'brand-b', name: 'Stonecrop', port: 3102, locales: ['en-GB'] },
      { code: 'brand-c', name: 'Brand C', port: 3103, locales: ['en-US'] },
    );
    const hyphen = pairs.findIndex(([from]) => from === 'brand-b');
    const camel = pairs.findIndex(([from]) => from === 'brandB');
    expect(hyphen).toBeGreaterThanOrEqual(0);
    expect(camel).toBeGreaterThan(hyphen);
  });

  it('rewrites a seed-id citation whole', () => {
    const pairs = substitutions(
      { code: 'brand-b', name: 'Stonecrop', port: 3102, locales: ['en-GB'] },
      { code: 'brand-c', name: 'Brand C', port: 3103, locales: ['en-US'] },
    );
    expect(rewrite('SEED_IDS.publishableKeys.brandB', pairs)).toBe(
      'SEED_IDS.publishableKeys.brandC',
    );
  });
});

describe('localePairs', () => {
  it('rewrites one locale to one locale', () => {
    expect(localePairs({ locales: ['en-GB'] }, { locales: ['en-US'] })).toEqual([
      ['en-GB', 'en-US'],
    ]);
  });

  it('emits nothing when either side has more than one, because there is no single mapping', () => {
    expect(localePairs({ locales: ['en-GB', 'de-DE'] }, { locales: ['en-US'] })).toEqual([]);
    expect(localePairs({ locales: ['en-GB'] }, { locales: ['en-US', 'es-US'] })).toEqual([]);
  });

  it('emits nothing when the locale does not change', () => {
    expect(localePairs({ locales: ['en-GB'] }, { locales: ['en-GB'] })).toEqual([]);
  });
});

describe("the lighthouse config's locale", () => {
  it('is SUBSTITUTED, not verbatim: a 404 is not a performance score', () => {
    // It was verbatim, for #348's numberOfRuns: 5. Brand C's first generated copy therefore
    // measured `/en-GB/products` -- a locale brand C does not serve.
    expect(TEMPLATE_FILES.substituted).toContain('lighthouserc.json');
    expect(TEMPLATE_FILES.verbatim).not.toContain('lighthouserc.json');
  });

  it('keeps numberOfRuns and the LCP budget while rewriting the collect URLs', () => {
    const config = JSON.stringify({
      ci: {
        collect: {
          url: ['http://127.0.0.1:3100/en-GB/products'],
          numberOfRuns: 5,
        },
        assert: {
          assertions: { 'largest-contentful-paint': ['error', { maxNumericValue: 2500 }] },
        },
      },
    });
    const out = JSON.parse(
      rewrite(
        config,
        substitutions(
          { code: 'brand-b', name: 'Stonecrop', port: 3102, locales: ['en-GB'] },
          { code: 'brand-c', name: 'Brand C', port: 3103, locales: ['en-US'] },
          'lighthouserc.json',
        ),
      ),
    );
    // The port stays 3100 for every brand: scripts/perf.mjs starts its own server there.
    expect(out.ci.collect.url).toEqual(['http://127.0.0.1:3100/en-US/products']);
    expect(out.ci.collect.numberOfRuns).toBe(5);
    expect(out.ci.assert.assertions['largest-contentful-paint'][1].maxNumericValue).toBe(2500);
  });
});

describe('localeMismatch', () => {
  it("pins STARTER_LOCALES against the starter's own default, so it cannot drift", () => {
    // If window 3 changes the starter's locales this fails here, not inside a generated brand.
    //
    // Against `localeConfigFromEnv({})` — an EMPTY env — rather than this app's `routing.locales`,
    // which is what it used to read. Since #441 part 5 routing reflects whatever `SUPPORTED_LOCALES`
    // says, so reading it here asked "what does this brand serve?" while the name promised "what
    // does the starter default to?". The two agree only while the brand happens to be brand A, and
    // the test went red the moment brand B's own locale reached vitest. The same mistake this file
    // is full of findings about: a test whose name describes one invariant and whose body checks
    // another.
    expect(STARTER_LOCALES).toEqual(localeConfigFromEnv({}).locales);
  });

  it('is null for a brand on a locale the starter already serves -- brand B', () => {
    expect(localeMismatch({ locales: ['en-GB'] })).toBeNull();
  });

  it('reports the three things it refuses to touch, for a brand on another locale', () => {
    const gap = localeMismatch({ locales: ['en-US'] });
    expect(gap).not.toBeNull();
    expect(gap!.locales).toEqual(['en-US']);
    expect(gap!.files.map((file) => file.path)).toEqual([
      'scripts/e2e-server.mjs',
      'the Prism mock itself',
      'e2e/*.spec.ts',
    ]);
  });

  it('says e2e fails BEFORE the first test, not that a test fails', () => {
    // The distinction a reader needs: the warm-up throws, so there is no test result to read.
    const warmUp = localeMismatch({ locales: ['en-US'] })!.files[0]!;
    expect(warmUp.effect).toMatch(/does not start/);
    expect(warmUp.effect).toContain('120 s');
  });

  it('describes the mechanism that was MEASURED, not the one that was guessed', () => {
    // The first version of this text said the path 404s and `timed()` rejects it for status >= 400.
    // Running it on brand C showed otherwise: next-intl answers 307 with
    // `location: /en-US/en-GB`, the page counts as warm in 5 ms, and it is the chunk — discovered
    // by regex out of the page body — that is never found in a 12-byte redirect. Same outcome,
    // different cause, and the difference is what a reader needs to recognise the log.
    const warmUp = localeMismatch({ locales: ['en-US'] })!.files[0]!;
    expect(warmUp.effect).toContain('307');
    expect(warmUp.effect).toMatch(/MEASURED/);
    expect(warmUp.effect).toMatch(/page 5 ms/);
    expect(warmUp.effect).not.toMatch(/returns null for any status/);
  });

  it('does not propose excluding the specs, which would delete the suite', () => {
    const specs = localeMismatch({ locales: ['en-US'] })!.files[2]!;
    expect(specs.effect).toMatch(/rather than port it/);
    expect(localeMismatch({ locales: ['en-US'] })!.remedy).toMatch(/#441 part 4/);
    // And the remedy carries what the measurement added: a redirect must not count as warm.
    expect(localeMismatch({ locales: ['en-US'] })!.remedy).toMatch(/3xx as NOT warm/);
  });

  it('reports that the Prism mock cannot serve such a brand at all', () => {
    // Measured: every publishable key answers code=brand-a, locales=[en-GB, de-DE], and
    // assertStoreOffersLocale 404s a locale the STORE does not offer. So there is no mock render
    // check and no mock e2e run for a brand on a new locale -- its e2e has to be a core leg.
    const mock = localeMismatch({ locales: ['en-US'] })!.files[1]!;
    expect(mock.path).toBe('the Prism mock itself');
    expect(mock.effect).toMatch(/MEASURED/);
    expect(mock.effect).toMatch(/fail-closed/);
    expect(mock.effect).toMatch(/CORE leg/);
  });

  it('says the mock reds the PERF leg in CI, which I first said it did not', () => {
    // The correction #444 forced: I checked the live job (brand storefronts on the kept core) and
    // generalised "CI" from one job. scripts/perf.mjs measures ALWAYS against the mock by design,
    // so a brand on a new locale reds its perf leg -- Lighthouse fails on a warm-up that never
    // succeeds, while the bundle budget passes because it reads a build. REQUEST #447.
    const mock = localeMismatch({ locales: ['en-US'] })!.files[1]!;
    expect(mock.effect).toMatch(/PERF LEG/);
    expect(mock.effect).toMatch(/#447/);
    expect(mock.effect).not.toMatch(/does not affect CI/);
  });

  it('names the mismatching locale only, not every locale the brand sells', () => {
    expect(localeMismatch({ locales: ['en-GB', 'en-US'] })!.locales).toEqual(['en-US']);
  });

  it('names the inherited shipping address, which no substitution can fix', () => {
    // #444 review: the generator carries brand B's Manchester address into every new brand, and a
    // pair that rewrote GB into another country does not exist. Silence here costs the next brand
    // four timing-out funnel tests that read like a checkout bug.
    const step = manualSteps(parseArgs(ARGS)).find((entry) => entry.step.includes('shipping'));
    expect(step).toBeDefined();
    expect(step?.where).toContain('E2E_SHIP_ADDRESS_JSON');
    expect(step?.why).toMatch(/No delivery options/);
    // And it says why a placeholder will not do, so nobody tries one.
    expect(step?.why).toMatch(/two\s+letters/);
  });

  it('is reported as a manual step, so a generated brand cannot miss it', () => {
    // Specific: there are two locale steps now, and the other one is about prose.
    const step = manualSteps(parseArgs(ARGS)).find((entry) => entry.step.includes('synced e2e'));
    expect(step).toBeDefined();
    expect(step?.where).toContain('e2e-server.mjs');
    expect(step?.why).toMatch(/does not run against this brand/);
  });
});

describe('a locale literal in prose is not the brand’s', () => {
  const template = { code: 'brand-b', name: 'Stonecrop', port: 3102, locales: ['en-GB'] };
  const target = { code: 'brand-c', name: 'Brand C', port: 3103, locales: ['en-US'] };

  it('rewrites the locale only in the files where it is data', () => {
    expect(LOCALE_DATA_FILES).toEqual(['lighthouserc.json']);
    const inData = substitutions(template, target, 'lighthouserc.json').map(([from]) => from);
    const inProse = substitutions(template, target, 'next.config.mjs').map(([from]) => from);
    expect(inData).toContain('en-GB');
    expect(inProse).not.toContain('en-GB');
  });

  it('leaves the locale alone when no file is named, so a caller must opt in', () => {
    expect(substitutions(template, target).map(([from]) => from)).not.toContain('en-GB');
  });

  it('does not turn a true sentence about the STARTER into a false one', () => {
    // Both of these were produced by the first, unscoped version, and both are false:
    // the starter defaults to 'en-GB,de-DE' and seo-head.spec.ts declares ['en-GB','de-DE'].
    const aboutTheStarter =
      "the starter's `src/i18n/routing.ts` defaults `SUPPORTED_LOCALES` to `'en-GB,de-DE'`";
    expect(rewrite(aboutTheStarter, substitutions(template, target, 'next.config.mjs'))).toContain(
      "'en-GB,de-DE'",
    );
    const quote = "seo-head.spec.ts declares `const LOCALES = ['en-GB', 'de-DE']`";
    expect(rewrite(quote, substitutions(template, target, 'playwright.config.ts'))).toContain(
      "'en-GB', 'de-DE'",
    );
  });

  it('still rewrites the brand-specific parts of those same files', () => {
    const pairs = substitutions(template, target, 'next.config.mjs');
    expect(rewrite("pk = '" + devPublishableKey('brand-b') + "';", pairs)).toContain(
      devPublishableKey('brand-c'),
    );
    expect(rewrite('client storefront-brand-b', pairs)).toBe('client storefront-brand-c');
  });

  it('reports the two prose blocks a human has to rewrite', () => {
    expect(localeProse(template, target).map((entry) => entry.path)).toEqual([
      'next.config.mjs',
      'playwright.config.ts',
    ]);
  });

  it('reports nothing when the brand sells the template’s locale', () => {
    expect(localeProse(template, { ...target, locales: ['en-GB'] })).toEqual([]);
  });

  it('is named as a manual step, with both files', () => {
    const step = manualSteps(parseArgs(ARGS)).find((entry) =>
      entry.step.includes('locale reasoning'),
    );
    expect(step).toBeDefined();
    expect(step?.where).toContain('next.config.mjs');
    expect(step?.where).toContain('playwright.config.ts');
  });
});

describe('the seeded brands', () => {
  it('lists exactly the brands packages/db SEED_IDS creates a store for', () => {
    expect(SEEDED_BRANDS).toEqual(['brand-a', 'brand-b', 'brand-c']);
  });

  it('tells a seeded brand to CHECK the seeded store, not to run the wizard', () => {
    // Brand C's store, legal entity, USD/en-US, shippingCountries ['US'] and publishable key are
    // all in packages/db already. Sending its author to the onboarding wizard would have them
    // create a second store for the same brand.
    const step = manualSteps(parseArgs(ARGS)).find((entry) => entry.step.startsWith('the store'));
    expect(step?.where).toContain('SEED_IDS');
    expect(step?.where).toContain('brandC');
    expect(step?.why).toMatch(/CHECK THEM/);
    expect(step?.why).not.toMatch(/onboarding wizard/);
  });

  it('sends a brand that is NOT seeded to the onboarding wizard', () => {
    const fourth = parseArgs([
      'brand-d',
      '--name',
      'Brand D',
      '--currency',
      'eur',
      '--locale',
      'fr-FR',
      '--port',
      '3104',
      '--jurisdiction',
      'de',
    ]);
    const step = manualSteps(fourth).find((entry) => entry.step.startsWith('the store'));
    expect(step?.where).toContain('onboarding wizard');
    expect(step?.why).toMatch(/section 6/);
  });
});

describe('messageCatalogues', () => {
  it('asks for nothing when the brand sells a locale the starter ships', () => {
    // Brand B. This is why #437 never met the bug.
    expect(messageCatalogues({ locales: ['en-GB'] })).toEqual([]);
    expect(messageCatalogues({ locales: ['en-GB', 'de-DE'] })).toEqual([]);
  });

  it('bases a new catalogue on the starter catalogue in the SAME language', () => {
    const [catalogue] = messageCatalogues({ locales: ['en-US'] });
    expect(catalogue?.file).toBe('messages/en-US.json');
    expect(catalogue?.basedOn).toBe('messages/en-GB.json');
    expect(catalogue?.needsTranslation).toBe(false);
  });

  it('marks a catalogue in a language the starter does not ship as UNTRANSLATED', () => {
    // Copying English into fr-FR gives an app that renders, which is worse than one that fails:
    // nothing then reports that no translation was done.
    const [catalogue] = messageCatalogues({ locales: ['fr-FR'] });
    expect(catalogue?.needsTranslation).toBe(true);
    expect(catalogue?.why).toMatch(/untranslated/i);
  });

  it('asks for one catalogue per missing locale, and only the missing ones', () => {
    expect(messageCatalogues({ locales: ['en-GB', 'en-US', 'fr-FR'] }).map((c) => c.file)).toEqual([
      'messages/en-US.json',
      'messages/fr-FR.json',
    ]);
  });

  it('is a manual step that says the app does not render without it', () => {
    // The sharpest edge of the locale gap: src/i18n/request.ts imports the catalogue unguarded,
    // so this is not a missing-string problem, it is an every-page-throws problem.
    const step = manualSteps(parseArgs(ARGS)).find((entry) => entry.step.includes('catalogue'));
    expect(step).toBeDefined();
    expect(step?.where).toContain('messages/en-US.json');
    expect(step?.where).toContain('messages/en-GB.json');
    expect(step?.why).toMatch(/does not render AT ALL/);
  });

  it('does not add a catalogue step for a brand that needs none', () => {
    const brandB = { ...parseArgs(ARGS), locales: ['en-GB'] };
    expect(manualSteps(brandB).filter((entry) => entry.step.includes('catalogue'))).toEqual([]);
  });
});
