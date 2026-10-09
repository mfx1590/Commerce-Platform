import { describe, expect, it } from 'vitest';
import {
  BRAND_CODE,
  KNOWN_JURISDICTIONS,
  NewBrandError,
  TEMPLATE_FILES,
  devPublishableKey,
  e2eExclusions,
  manualSteps,
  parseArgs,
  rewrite,
  runtimeDefaults,
  substitutions,
} from '../../scripts/new-brand-plan.mjs';

/**
 * `apps/storefronts/scripts/new-brand-plan.mjs` — the rules behind `new-brand.mjs` (#438).
 *
 * It lives in brand B's suite because brand B is the generator's template and there is no package at
 * `apps/storefronts/`; the same arrangement as `brand-media.test.ts`, which reaches into
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
  const template = { code: 'brand-b', name: 'Stonecrop', port: 3102 };
  const target = { code: 'brand-c', name: 'Brand C', port: 3103 };

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
  const target = { code: 'brand-c', name: 'Brand C', jurisdiction: 'US' };

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
    const store = manualSteps(target).find((s) => s.step.includes('store, legal entity'));
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
    const us = manualSteps(target).find((s) => s.step.includes('legal documents'));
    expect(us?.why).toMatch(/no brand has been written for US yet/);
    expect(us?.why).toMatch(/from scratch/);
    // It must not invent instruments it has never been given.
    expect(us?.why).not.toMatch(/Act \d{4}/);
  });
});

describe('TEMPLATE_FILES', () => {
  it('takes lighthouserc.json from the template, not the starter', () => {
    // The starter is still numberOfRuns: 3. Copying it would re-introduce #348's flaky gate.
    expect(TEMPLATE_FILES.verbatim).toContain('lighthouserc.json');
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
