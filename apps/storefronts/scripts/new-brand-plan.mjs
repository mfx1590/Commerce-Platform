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
};

export class NewBrandError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NewBrandError';
  }
}

export const USAGE = `
Usage:
  node apps/storefronts/scripts/new-brand.mjs <code> \\
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
export function substitutions(template, target) {
  const pairs = [
    [devPublishableKey(template.code), devPublishableKey(target.code)],
    [`storefront-${template.code}`, `storefront-${target.code}`],
    [`@platform/storefront-${template.code}`, `@platform/storefront-${target.code}`],
    [`cms/${template.code}`, `cms/${target.code}`],
    [String(template.port), String(target.port)],
    [template.name, target.name],
    [template.code, target.code],
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
  verbatim: [
    // numberOfRuns: 5 and the 2500 ms budget (#348). The STARTER is still 3 — copying its version
    // would silently re-introduce the flaky perf gate #348 measured.
    'lighthouserc.json',
    'tsconfig.json',
    'tailwind.config.ts',
    'bundle-budget.json',
  ],
  substituted: [
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
      where: 'the admin onboarding wizard (#428), not this script',
      why:
        'since 2026-10-08 a store is created with onboardStore. Doing it here would duplicate ' +
        'the wizard and bypass its permission checks. ONBOARDING-GAPS.md section 6.',
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
