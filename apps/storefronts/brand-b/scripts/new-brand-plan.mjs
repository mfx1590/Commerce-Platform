/**
 * The rules behind `new-brand.mjs`, with **no filesystem access**, so they can be unit-tested
 * directly — the same arrangement `merge-package-json.mjs` uses for the sync's merge rules.
 *
 * ## What this module decides, and what it refuses to decide
 *
 * `apps/storefronts/brand-b/ONBOARDING-GAPS.md` (written while creating brand B, #437) is this
 * script's specification, and it already drew the line:
 *
 * - **§ 1 — mechanical.** A script can do all of it. That is `plan()` below.
 * - **§ 2 — decisions.** A script must **ask**, and a default would be wrong. Those are required
 *   arguments here, and `parseArgs` refuses without them. The brand's **name**, its **locale list**
 *   and above all its **legal jurisdiction** are not derivable: brand A's imprint cites German
 *   statutes, brand B's cite the Consumer Rights Act 2015 and UK GDPR, brand C's would cite neither.
 *   A generator can supply the four legal documents' *structure* and placeholder names, never their
 *   law.
 * - **§ 6 — not ours.** A brand that is not already in the seed needs a store, a legal entity, a
 *   publishable key and a Keycloak client. Since 2026-10-08 that is `onboardStore` and the admin
 *   onboarding wizard (#428). This script **stops at the app and the content and points at the
 *   wizard**: duplicating the store create here would bypass its permission checks.
 *
 * ## The one rule that matters most
 *
 * **Derive a new brand from an existing BRAND, never from the starter.** The brand copies carry
 * fixes the starter does not: `numberOfRuns: 5` (#348), the `STORE_PUBLISHABLE_KEY ??=` line in
 * `playwright.config.ts` (#382), platform-keyed visual snapshots, and the deliberate refusal to
 * import `RUNTIME_SITE_URL` (#379). A generator seeded from the starter would reproduce three
 * solved bugs in every brand after the first.
 */

/** `brand-a`, `brand-b`, … — the store code, which is also the Sanity dataset name by contract. */
export const BRAND_CODE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** ISO 4217, upper case. */
export const CURRENCY = /^[A-Z]{3}$/;
/** BCP-47 as this platform uses it: `en-GB`, `de-DE`, `en-US`. */
export const LOCALE = /^[a-z]{2}-[A-Z]{2}$/;

/**
 * Jurisdictions whose legal document set this platform has already written once, so the script can
 * say which instruments to cite. Anything else is accepted but flagged as needing a lawyer from
 * scratch — the script must not pretend to know, say, Japanese consumer law.
 */
export const KNOWN_JURISDICTIONS = {
  DE: {
    label: 'Germany',
    reference: 'cms/brand-a/content/legal.json',
    instruments: ['§ 5 TMG (Impressum)', 'BGB distance-selling rules', 'EU GDPR'],
  },
  GB: {
    label: 'United Kingdom',
    reference: 'cms/brand-b/content/legal.json',
    instruments: [
      'Consumer Rights Act 2015',
      'Consumer Contracts Regulations 2013',
      'UK GDPR / Data Protection Act 2018 (ICO)',
    ],
  },
  /**
   * Added by #438, from brand C's drafts. The instruments are the shape of the difference, not a
   * translation of the European ones: there is **no federal right to cancel an online order** in
   * the US (the FTC's Cooling-Off Rule is for door-to-door and other off-premises sales), prices
   * are quoted WITHOUT sales tax rather than inclusive of VAT, and privacy is state law rather
   * than one statute. A returns document ported from brand A or B would promise a statutory right
   * that does not exist and quote a tax-inclusive price that is wrong at checkout.
   */
  US: {
    label: 'United States',
    reference: 'cms/brand-c/content/legal.json',
    instruments: [
      'UCC Article 2 as adopted by the state',
      'FTC Mail, Internet, or Telephone Order Merchandise Rule (the 30-day rule — and NOT the Cooling-Off Rule, which does not cover online sales)',
      'CCPA/CPRA for California residents, plus the state data-security law (NY SHIELD for brand C)',
      'COPPA and CAN-SPAM',
    ],
  },
};

export class NewBrandError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NewBrandError';
  }
}

export const USAGE = `
Usage:
  node apps/storefronts/brand-b/scripts/new-brand.mjs <code> \\
    --name "<Brand name>" --currency <ISO> --locale <xx-XX>[,<xx-XX>] \\
    --port <number> --jurisdiction <ISO-3166-alpha-2> [--template <brand-code>] [--dry-run]

Every option is required because none of them has a safe default. See
apps/storefronts/brand-b/ONBOARDING-GAPS.md section 2 for why each one is a decision and not a
default — the name, the locale list and the legal jurisdiction in particular.
`.trim();

/**
 * Parse and validate. Throws `NewBrandError` with something actionable rather than returning a
 * half-filled object: a generator that guesses is worse than one that stops.
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new NewBrandError(`${arg} needs a value.\n\n${USAGE}`);
      }
      flags[arg.slice(2)] = value;
      i += 1;
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    throw new NewBrandError(
      `expected exactly one brand code, got ${positional.length}.\n\n${USAGE}`,
    );
  }
  const code = positional[0];
  if (!BRAND_CODE.test(code)) {
    throw new NewBrandError(
      `"${code}" is not a brand code: lower case, digits and single hyphens (e.g. brand-c).`,
    );
  }

  for (const required of ['name', 'currency', 'locale', 'port', 'jurisdiction']) {
    if (flags[required] === undefined || String(flags[required]).trim() === '') {
      throw new NewBrandError(
        `--${required} is required and has no default.\n\n` +
          'See apps/storefronts/brand-b/ONBOARDING-GAPS.md section 2: the name, the locale list ' +
          'and the legal jurisdiction are decisions a script must not make.\n\n' +
          USAGE,
      );
    }
  }

  const currency = String(flags.currency).toUpperCase();
  if (!CURRENCY.test(currency)) {
    throw new NewBrandError(
      `--currency must be a three-letter ISO 4217 code, got "${flags.currency}".`,
    );
  }

  const locales = String(flags.locale)
    .split(',')
    .map((locale) => locale.trim())
    .filter((locale) => locale !== '');
  if (locales.length === 0) {
    throw new NewBrandError('--locale must name at least one locale.');
  }
  for (const locale of locales) {
    if (!LOCALE.test(locale)) {
      throw new NewBrandError(`"${locale}" is not a locale this platform routes (e.g. en-US).`);
    }
  }
  if (new Set(locales).size !== locales.length) {
    throw new NewBrandError(`--locale repeats a locale: ${locales.join(',')}`);
  }

  const port = Number(flags.port);
  if (!Number.isInteger(port) || port < 3000 || port > 65535) {
    throw new NewBrandError(
      `--port must be a whole number from 3000 to 65535, got "${flags.port}".`,
    );
  }

  const jurisdiction = String(flags.jurisdiction).toUpperCase();
  if (!/^[A-Z]{2}$/.test(jurisdiction)) {
    throw new NewBrandError(
      `--jurisdiction must be an ISO 3166-1 alpha-2 country code, got "${flags.jurisdiction}".`,
    );
  }

  return {
    code,
    name: String(flags.name).trim(),
    currency,
    locales,
    port,
    jurisdiction,
    template: flags.template === undefined ? 'brand-b' : String(flags.template),
    dryRun: flags.dryRun === true,
  };
}

/**
 * The locales `apps/storefront-starter` serves, and writes into its synced specs as literals.
 * Not read from the starter: this module is pure, and the value is a fact about window 3's app
 * that a brands window must not silently track. `test/new-brand-plan.test.ts` pins it against
 * `src/i18n/routing.ts`'s default so it cannot drift unnoticed.
 */
export const STARTER_LOCALES = ['en-GB', 'de-DE'];

/**
 * The brands `packages/db`'s seed already creates a store, legal entity and publishable key for.
 *
 * Not a guess: `SEED_IDS` has `brandA`, `brandB` and `brandC`, and `packages/db/CLAUDE.md` says so.
 * It matters because the generator's advice is the opposite for the two cases — a seeded brand must
 * have its command-line currency and locale CHECKED against the seeded store, while a fourth brand
 * has to be created through the onboarding wizard (#428) instead.
 */
export const SEEDED_BRANDS = ['brand-a', 'brand-b', 'brand-c'];

/** The seeded dev publishable key for a brand code. Public by design; local databases only. */
export function devPublishableKey(code) {
  return `pk_${code}_dev_${'0'.repeat(20)}`;
}

/**
 * The text substitutions that turn the template brand's files into the new brand's.
 *
 * Ordered longest-first so that `pk_brand-b_dev_…` is rewritten before the bare `brand-b` inside it
 * would be — otherwise the key becomes `pk_brand-c_dev_…` by two overlapping edits and the result
 * depends on iteration order.
 */
/**
 * The prose forms of a brand code. This repo writes `brand-a` in code and "brand A" in sentences, so
 * a generator that only rewrites the code leaves the *documentation* talking about the template
 * brand — which is how brand C's launch gate first reported "brand B still has 13 placeholders".
 * Only `brand-<letter>` codes have a prose form; `acme` is just `acme` in both.
 */
export function proseForms(code) {
  const match = /^brand-([a-z])$/.exec(code);
  if (match === null) return [];
  const letter = match[1].toUpperCase();
  return [`brand ${letter}`, `Brand ${letter}`];
}

/**
 * The camelCase form of a brand code, as `packages/db`'s `SEED_IDS` spells it
 * (`SEED_IDS.publishableKeys.brandB`). Prose that cites a seed id is prose a substitution table
 * that only knows `brand-b` and `brand B` leaves pointing at the template's store — which is how
 * brand C's `next.config.mjs` came out citing `brandB`.
 *
 * @param {string} code
 * @returns {string | null}
 */
export function camelForm(code) {
  const match = /^brand-([a-z])$/.exec(code);
  return match === null ? null : `brand${match[1].toUpperCase()}`;
}

/**
 * The locale pair, when there is exactly one on each side.
 *
 * The starter's URL space is `en-GB` and `de-DE`, and every synced spec, the lighthouse URL list
 * and the e2e warm-up path are written in `en-GB` literals. Brand B is `en-GB`, so cloning it was
 * free and told us nothing. A brand on any other locale needs each of those literals rewritten,
 * and `en-GB` is too generic a string to rewrite blind: with two locales on either side there is no
 * single correct mapping, so this returns nothing and `localeMismatch` reports it instead.
 *
 * @param {{ locales: readonly string[] }} template
 * @param {{ locales: readonly string[] }} target
 * @returns {[string, string][]}
 */
export function localePairs(template, target) {
  if (template.locales.length !== 1 || target.locales.length !== 1) return [];
  const [from] = template.locales;
  const [to] = target.locales;
  return from === to ? [] : [[from, to]];
}

/**
 * The files whose locale literals are DATA, and may be rewritten.
 *
 * Everywhere else in a template brand's own files the locale appears inside prose, and prose
 * distinguishes two things a substitution table cannot:
 *
 * - the locale the BRAND sells ("Brand B sells in en-GB only") - which should be rewritten, and
 * - the locale the STARTER serves ("the starter defaults SUPPORTED_LOCALES to 'en-GB,de-DE'",
 *   "seo-head.spec.ts declares ['en-GB','de-DE']") - which must NOT be, because it is a fact about
 *   window 3's app, and rewriting it turns a true sentence into a false one.
 *
 * Brand C's first generated copy claimed the starter defaults to `'en-US,de-DE'` and that
 * `seo-head.spec.ts` declares `['en-US','de-DE']`. Both false, both produced by a table that was
 * right about the collect URLs two files away. So the rewrite is scoped to where the locale is a
 * value, and `localeProse` reports the prose for a human to write instead.
 */
export const LOCALE_DATA_FILES = ['lighthouserc.json'];

/**
 * The template's own files whose PROSE argues from the template brand's locale and history, and so
 * has to be rewritten by hand. `substitutions` deliberately leaves them alone.
 *
 * Returns `[]` when the brand's locale matches the template's: then the inherited prose is true.
 *
 * @param {{ code: string, locales: readonly string[] }} template
 * @param {{ code: string, locales: readonly string[] }} target
 */
export function localeProse(template, target) {
  if (localePairs(template, target).length === 0) return [];
  return [
    {
      path: 'next.config.mjs',
      what: `the SUPPORTED_LOCALES block explains why ${template.code} needs the runtime default`,
      why:
        "it quotes the starter's own default and says which brand was the first to need the " +
        'override. Both are facts about other apps; neither is rewritten.',
    },
    {
      path: 'playwright.config.ts',
      what: 'the locale-plural exclusion block quotes the literal seo-head.spec.ts declares',
      why:
        'the quote must stay the starter list or the comment stops matching the file it is ' +
        'about, while the surrounding argument is about the template brand.',
    },
  ];
}

/**
 * @param {string | null} [file] the file being rewritten, or null for pairs that suit any file.
 *   Locale pairs are included only for `LOCALE_DATA_FILES`.
 */
export function substitutions(template, target, file = null) {
  const templateProse = proseForms(template.code);
  const targetProse = proseForms(target.code);
  const pairs = [
    // Prose before code: "brand B" must not be left behind by rewriting only `brand-b`.
    ...(templateProse.length === targetProse.length
      ? templateProse.map((from, i) => [from, targetProse[i]])
      : []),
    ...(file !== null && LOCALE_DATA_FILES.includes(file) ? localePairs(template, target) : []),
    [devPublishableKey(template.code), devPublishableKey(target.code)],
    [`storefront-${template.code}`, `storefront-${target.code}`],
    [`@platform/storefront-${template.code}`, `@platform/storefront-${target.code}`],
    [`cms/${template.code}`, `cms/${target.code}`],
    [String(template.port), String(target.port)],
    [template.name, target.name],
    [template.code, target.code],
    // After the hyphenated code, which is longer, so neither consumes the other.
    ...(camelForm(template.code) === null || camelForm(target.code) === null
      ? []
      : [[camelForm(template.code), camelForm(target.code)]]),
  ];
  // Longest source first: a shorter pattern must never consume part of a longer one.
  return pairs.filter(([from, to]) => from !== to).sort(([a], [b]) => b.length - a.length);
}

/** Apply `substitutions` to text, and report anything template-specific that survived. */
export function rewrite(text, pairs) {
  let out = text;
  for (const [from, to] of pairs) out = out.split(from).join(to);
  return out;
}

/**
 * Files taken from the TEMPLATE BRAND rather than the starter, because the brand copies carry fixes
 * the starter does not. `verbatim` are copied byte for byte; `substituted` go through `rewrite`.
 *
 * Everything else in the app comes from `sync-from-starter.mjs`, which the script runs first.
 */
export const TEMPLATE_FILES = {
  verbatim: ['tsconfig.json', 'tailwind.config.ts', 'bundle-budget.json'],
  substituted: [
    // numberOfRuns: 5 and the 2500 ms budget (#348) — the STARTER is still 3, so copying its
    // version would silently re-introduce the flaky perf gate #348 measured. SUBSTITUTED, not
    // verbatim: its two collect URLs carry the locale (`/en-GB/products`), and a brand on another
    // locale would measure two 404s and call the result a performance score. Brand C's first
    // generated copy did exactly that. The port in them is `3100` for every brand — `scripts/
    // perf.mjs` starts its own `next start --port ${PERF_PORT ?? 3100}` — so no port pair applies.
    'lighthouserc.json',
    'package.json',
    'next.config.mjs',
    'playwright.config.ts',
    'scripts/start.mjs',
    'test/launch-gate.test.ts',
  ],
  /** Copied from the template's `cms/<code>/scripts/`, which the brand owns. */
  cmsScripts: ['resolve-media.mjs', 'seed-content.mjs', 'upload-media.mjs'],
};

/**
 * The runtime defaults the new brand's `next.config.mjs` must carry, beyond the publishable key.
 *
 * Both were found the hard way on brand B (#437), and both live in files the sync owns, so a brand
 * cannot fix them in place:
 *
 * - `SUPPORTED_LOCALES`: `src/i18n/routing.ts` defaults to the starter's `'en-GB,de-DE'`. A brand
 *   that sells something else and stays quiet serves a URL space with no content behind it.
 * - `KEYCLOAK_CLIENT_ID`: `src/lib/auth/oidc.ts` falls back to **`storefront-brand-a`**. A brand
 *   that stays quiet signs its customers in through brand A's client — and because the `store_code`
 *   claim is stamped per client, it mints sessions scoped to `brand-a`, which the core is right to
 *   refuse. It surfaces as Keycloak answering "Invalid parameter: redirect_uri", which reads like a
 *   realm misconfiguration and is not.
 */
export function runtimeDefaults(target) {
  return [
    { name: 'STORE_PUBLISHABLE_KEY', value: devPublishableKey(target.code) },
    { name: 'SUPPORTED_LOCALES', value: target.locales.join(',') },
    { name: 'KEYCLOAK_CLIENT_ID', value: `storefront-${target.code}` },
  ];
}

/**
 * The e2e exclusions every brand needs while #441 is open, emitted by the script so there is **one**
 * place to delete them from when it lands — rather than three brands to chase.
 *
 * A brand whose market is not the starter's needs the second group; a brand that does not sell the
 * starter's two locales needs the first.
 */
export function e2eExclusions(target) {
  const singleLocale = target.locales.length === 1;
  return {
    localePlural: singleLocale
      ? {
          specs: ['**/seo-head.spec.ts'],
          tests: ['in German is translated', 'offers hreflang alternates'],
          reason:
            "seo-head.spec.ts hard-codes ['en-GB','de-DE'] and derives its hreflang count from " +
            'it; checkout.spec.ts navigates to /de-DE/products. This brand sells ' +
            `${target.locales.join(', ')}. #441 part 1 asks for the list to come from the app's ` +
            'own routing. NOTE: this loses the <head> metadata assertion entirely.',
        }
      : null,
    foreignMarket: {
      tests: [
        'PLP → PDP → cart → checkout → confirmation',
        'a signed-in customer can buy',
        'a stale session still buys',
        'the confirmation shows the order processing once shipped',
      ],
      reason:
        "e2e/support/journey.ts's completeAddressStep fills a Netherlands address with no " +
        'override. A brand that does not ship to NL is told "No delivery options are available ' +
        'for this address" and these time out. #441 part 3 asks for the address to come from the ' +
        "brand. The brand's own e2e/journey.spec.ts replaces them so the coverage moves rather " +
        'than disappears. There are FOUR, not three: the fourth was found by running, not reading.',
    },
  };
}

/**
 * The UI message catalogue a brand needs when it sells a locale the starter has no `messages/` file
 * for, and the starter catalogue to base it on.
 *
 * This is the locale gap's sharpest edge, and the only part of it that stops the app rather than
 * the tests. `src/i18n/request.ts` does:
 *
 *     messages: { ...(await import(`../../messages/${locale}.json`)).default, ... }
 *
 * Unguarded - the try/catch next to it covers only window 6's optional `content` catalogue. And the
 * locale it resolves comes from `routing.locales`, which reads `SUPPORTED_LOCALES`. So a brand that
 * correctly declares its own locale and ships no catalogue for it throws on **every page**, in dev,
 * in `next build` and in production alike. Brand B never met this: it sells `en-GB`, and
 * `messages/en-GB.json` is one of the two the starter ships.
 *
 * The brand owns the file it writes. `sync-from-starter.mjs` copies the starter's `git ls-files` and
 * prunes nothing, so a catalogue the starter does not have survives every re-sync.
 *
 * `basedOn` is the starter catalogue in the same language when there is one (`en-US` from `en-GB`:
 * 139 strings, of which brand C needed two spellings changed), otherwise the starter's first locale
 * and `needsTranslation: true` - because copying English into a `fr-FR` catalogue produces an app
 * that renders, which is worse than one that fails, since nothing then reports it.
 *
 * @param {{ locales: readonly string[] }} target
 * @param {readonly string[]} [starterLocales]
 */
export function messageCatalogues(target, starterLocales = STARTER_LOCALES) {
  const language = (locale) => locale.split('-')[0];
  return target.locales
    .filter((locale) => !starterLocales.includes(locale))
    .map((locale) => {
      const sameLanguage = starterLocales.find((other) => language(other) === language(locale));
      return {
        file: `messages/${locale}.json`,
        basedOn: `messages/${sameLanguage ?? starterLocales[0]}.json`,
        needsTranslation: sameLanguage === undefined,
        why:
          sameLanguage === undefined
            ? `the starter ships no ${language(locale)} catalogue, so every one of its strings is ` +
              'a translation nobody has done. The file is copied so the app renders; treat it as ' +
              'untranslated until someone says otherwise.'
            : `same language as ${sameLanguage}, so the copy is a starting point rather than a ` +
              'translation. Read it for regional wording.',
      };
    });
}

/**
 * The synced files that hard-code the starter's locale, which this script must NOT rewrite.
 *
 * `localePairs` rewrites the brand's OWN files. These are the sync's: `sync-from-starter.mjs`
 * replaces them from the starter on every re-sync, so a rewrite here is undone the first time
 * anyone re-syncs — and `sync --check` reports drift until then. Editing them is also window 3's
 * right, not a brand's. So the script reports them and stops.
 *
 * Returns `null` when the brand's locale is one the starter already serves: nothing to report.
 *
 * Brand B hid all of this. The starter serves `en-GB` and `de-DE`; brand B sells `en-GB`, so every
 * inherited literal happened to be right and the clone looked clean. Brand C sells `en-US` and
 * nothing inherited is right.
 *
 * @param {{ locales: readonly string[] }} target
 * @param {readonly string[]} [starterLocales]
 */
export function localeMismatch(target, starterLocales = STARTER_LOCALES) {
  if (target.locales.every((locale) => starterLocales.includes(locale))) return null;
  return {
    locales: target.locales.filter((locale) => !starterLocales.includes(locale)),
    starterLocales: [...starterLocales],
    files: [
      {
        path: 'scripts/e2e-server.mjs',
        what: `warms \`/${starterLocales[0]}\` before declaring the app ready`,
        effect:
          'its `timed()` returns null for any status >= 400, so a locale the app does not serve ' +
          'never counts as warm and `warmUp()` throws after 120 s. e2e does not start at all — ' +
          'it does not fail a test, it fails before the first one.',
      },
      {
        path: 'e2e/*.spec.ts',
        what: `navigate to \`/${starterLocales[0]}/…\` and assert that URL back`,
        effect:
          'every funnel, account, checkout, referral and image spec is written in the starter ' +
          'locale. Excluding them would delete the suite rather than port it, so they are left ' +
          'in place and reported here.',
      },
    ],
    remedy:
      'a REQUEST to window 3: take the locale from `src/i18n/routing.ts` (which already reads ' +
      '`SUPPORTED_LOCALES`) in the specs and in the warm-up path, instead of a literal. #441 ' +
      'parts 1 and 3 ask for the neighbouring version of this for the locale LIST and the ' +
      'address; this is the same shape for the locale PREFIX.',
  };
}

/**
 * What the script cannot do, printed at the end of a run. Keeping it here rather than in the CLI
 * means the list is unit-tested: a step that silently stops being printed is a step a brand forgets.
 */
export function manualSteps(target) {
  const known = KNOWN_JURISDICTIONS[target.jurisdiction];
  return [
    {
      step: 'the brand name is a placeholder until the owner agrees it',
      where: `apps/storefronts/${target.code}/src/brand/config.ts`,
      why: `"${target.name}" came from the command line, not from the business. LAUNCH.md row 0.1.`,
    },
    {
      step: 'theme tokens',
      where: `apps/storefronts/${target.code}/src/brand/tokens.ts`,
      why: 'a palette is a design decision; the generated file is the kit default, not a brand.',
    },
    {
      step: 'all content prose',
      where: `cms/${target.code}/content/*.json`,
      why: 'the document set is generated with placeholders; every sentence is a decision.',
    },
    {
      step: 'the four legal documents',
      where: `cms/${target.code}/content/legal.json`,
      why: known
        ? `${known.label}: cite ${known.instruments.join(', ')} — see ${known.reference} for a ` +
          'document set already written against that law. Still needs a lawyer.'
        : `no brand has been written for ${target.jurisdiction} yet: the structure is generated, ` +
          'the instruments are not. A lawyer writes these from scratch.',
    },
    {
      step: 'the media manifest has no bytes/sha256',
      where: `cms/${target.code}/media/manifest.json`,
      why: "the brand's stills do not exist; a made-up size or digest would be a false record.",
    },
    {
      step: 'the store, legal entity, publishable key and Keycloak client',
      where: SEEDED_BRANDS.includes(target.code)
        ? `already in the seed: packages/db SEED_IDS.*.${camelForm(target.code) ?? target.code}`
        : 'the admin onboarding wizard (#428), not this script',
      why: SEEDED_BRANDS.includes(target.code)
        ? `${target.code} has a seeded store, legal entity, tax rate, shipping countries and ` +
          'publishable key. CHECK THEM against what you passed on the command line rather than ' +
          'assuming: the app and the store disagreeing about currency or locale is a silent bug. ' +
          'The Keycloak client is still manual.'
        : 'since 2026-10-08 a store is created with onboardStore. Doing it here would duplicate ' +
          'the wizard and bypass its permission checks. ONBOARDING-GAPS.md section 6.',
    },
    ...messageCatalogues(target).map((catalogue) => ({
      step: `the UI message catalogue ${catalogue.file}${
        catalogue.needsTranslation ? ' - UNTRANSLATED' : ''
      }`,
      where: `apps/storefronts/${target.code}/${catalogue.file}, copied from ${catalogue.basedOn}`,
      why:
        `${catalogue.why} Without the file the app does not render AT ALL: ` +
        'src/i18n/request.ts imports it unguarded. See `messageCatalogues`.',
    })),
    {
      step: 'the locale reasoning inherited from the template brand',
      where: `apps/storefronts/${target.code}/next.config.mjs and playwright.config.ts`,
      why:
        'see `localeProse`: those comments quote the starter list and the template brand history. ' +
        'Rewriting either mechanically would make them false, so they are copied as the template ' +
        'wrote them and need a human.',
    },
    {
      step: 'the synced e2e specs and the e2e warm-up still speak the starter locale',
      where: `apps/storefronts/${target.code}/e2e/*.spec.ts and scripts/e2e-server.mjs`,
      why:
        'see `localeMismatch`: those files are replaced from the starter on every re-sync and are ' +
        "window 3's, so this script refuses to rewrite them. Until the REQUEST lands, this " +
        "brand's e2e suite is the starter's and does not run against this brand.",
    },
    {
      step: "the brand's infra/CI lines",
      where: 'a REQUEST to window 5 (docker-bake target, Dockerfile, terraform/deploy/helm lists)',
      why:
        'window 5 owns those paths. The perf and e2e CI legs need nothing: both self-detect a ' +
        'new storefront.',
    },
  ];
}
