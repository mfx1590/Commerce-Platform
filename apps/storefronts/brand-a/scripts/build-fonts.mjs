/**
 * Brand A's shipped faces, generated from the committed OFL sources (#739).
 *
 * ## Why this script exists
 *
 * Brand A's two self-hosted faces were the whole reason its LCP sat on the budget. Measured from
 * #738's CI artifacts and reproduced locally:
 *
 * - The LCP element is TEXT (`<h1 class="text-3xl font-bold leading-tight">`), identical markup in
 *   brands A, B and C. Its LCP phase table reads **Load Delay 0%, Load Time 0%** — no resource load
 *   gates it — and the whole A-vs-C difference is **render delay, +444 ms**.
 * - Brand A loads exactly two things B and C do not: these faces, **90.6 kB**. That is the entire
 *   request difference (23 requests / 262 kB against 21 / 171 kB).
 * - `90.6 kB x 8 / 1600 kbps` (Lighthouse mobile throttling) = **453 ms**. Nine milliseconds from
 *   the observed 444 ms. Confirmed a third time by detaching the faces locally: the worst run fell
 *   from 2674 to 2163 ms on the PLP and 2752 to 2233 ms on the PDP.
 *
 * So the cause is bytes contending for simulated bandwidth in the critical path, **not** the
 * `font-display: swap` repaint. `display: 'optional'` would have removed no bytes and would have
 * broken `e2e/visual.spec.ts`, which deliberately awaits `document.fonts.ready`.
 *
 * ## What it does, and what it refuses to do
 *
 * It keeps DESIGN.md section 3's pairing exactly — the serif voice over a neutral ground is brand
 * A's identity and is not for sale against a perf margin. It spends the two things that cost nothing
 * visible instead:
 *
 * 1. **The serif's weight axis**, pinned to wght 500 — and this is a **visible change**, which the
 *    first version of this file got wrong. It claimed `theme.css` already set `h1-h4` at medium so
 *    nothing rendered heavier. That was a misreading of the cascade: `theme.css` is an **element**
 *    rule and Tailwind's `.font-bold` is a **class**, which outranks it, so the 33 synced headings
 *    carrying `font-bold`/`font-semibold` — the LCP `<h1>` among them — were rendering real 700 and
 *    600. #765's review caught it.
 *    The pin is kept and the design is now **enforced** rather than aspirational: `theme.css` wins
 *    the specificity fight on serif headings and forbids synthetic bold, so headings render the 500
 *    DESIGN.md asks for ("at heading sizes it wants its lighter weights, not bold"). Headings are
 *    lighter than they were, deliberately. (DESIGN.md had already walked one step down this ladder:
 *    the `opsz` axis was dropped, 132 kB to 58 kB.)
 * 2. **Glyphs neither locale can render.** Both faces are subset to `CHARSET` below.
 *
 * The sans keeps a weight AXIS rather than becoming static instances — body copy, labels and controls
 * genuinely use 400, 500, 600 and 700, and separate files would trade bytes for extra requests — but
 * the axis is trimmed to **400-700**: the source carries 300-700 and nothing anywhere asks for 300.
 *
 * ## The charset, derived rather than guessed
 *
 * `--charset` scans brand A's catalogues and CMS content and prints what they actually contain: 92
 * distinct characters, of which four sit outside printable Latin-1 — EM DASH, the two double
 * quotation marks, and **U+201E DOUBLE LOW-9 QUOTATION MARK**, which `de-DE` opens quotes with and a
 * guess would have missed.
 *
 * **Printable Latin-1 is kept as the floor, deliberately, and that is not laziness.** Those scans
 * cover UI chrome and committed content; product names, category names and CMS prose arrive at
 * runtime from the Store API and Sanity. A face subset to only today's 92 characters renders a
 * tofu box the first time a product is called "Café". Latin-1 covers en-GB and de-DE in full,
 * including the umlauts and the eszett, which is the same coverage promise DESIGN.md section 3 makes.
 *
 * ## Usage
 *
 *   node scripts/build-fonts.mjs            # regenerate the shipped faces
 *   node scripts/build-fonts.mjs --check    # fail if the committed output is not a fresh build
 *   node scripts/build-fonts.mjs --charset  # print the derived charset and exit
 *
 * `--check` runs in `test/brand-fonts.test.ts`, so a hand-edited binary cannot pass review.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import subsetFont from 'subset-font';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const repo = path.resolve(app, '..', '..', '..');
const FONT_DIR = path.join(app, 'src', 'brand', 'fonts');
const SOURCE_DIR = path.join(FONT_DIR, 'source');

/**
 * The faces, their sources and what is spent on each.
 *
 * `variationAxes: { wght: 500 }` pins; omitting it keeps the source's axis as it is.
 */
export const FACES = [
  {
    source: 'newsreader-variable-latin.woff2',
    output: 'newsreader-latin.woff2',
    variationAxes: { wght: 500 },
    why: 'theme.css sets h1-h4 at medium and nothing else uses the serif',
  },
  {
    source: 'hanken-grotesk-variable-latin.woff2',
    output: 'hanken-grotesk-latin.woff2',
    // The axis is KEPT, only trimmed: `packages/ui` defines normal 400, medium 500, semibold 600
    // and bold 700, and the starter renders all four (font-medium x36, font-bold x19,
    // font-semibold x18, font-normal x1). Nothing anywhere asks for 300, so the source's
    // 300-400 range is dead weight. Trimming it, with the charset below: 33.9 kB -> 19.6 kB.
    variationAxes: { wght: { min: 400, max: 700 } },
    why: 'body, labels and controls use 400-700; statics would cost extra requests',
  },
];

/**
 * Typographic characters runtime text plausibly contains that no scan of this repo can see.
 *
 * Measured at **0.39 kB** for all four, which is why they are here rather than argued about. Store
 * API product names and Sanity prose are written by people, and people write apostrophes: a product
 * called "Men’s" with U+2019 missing falls back to the fallback face **for that one glyph**, which
 * looks like a rendering bug rather than a font choice. The en dash and ellipsis are the same story
 * in body copy.
 *
 * Deliberately NOT a general "add punctuation" list: `‚`, `•` and `™` are also absent and stay
 * absent until something actually needs them. Every character here costs bytes on the critical path
 * that #739 exists to defend.
 */
const TYPOGRAPHIC = '\u2019\u2018\u2013\u2026';

/** Printable Latin-1 — the floor, for runtime content this repo has never seen. */
const LATIN1 = [
  ...Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCodePoint(0x20 + i)),
  ...Array.from({ length: 0x100 - 0xa0 }, (_, i) => String.fromCodePoint(0xa0 + i)),
].join('');

/**
 * The characters `Intl` puts on the page that no catalogue can contain.
 *
 * The catalogue scan is necessary and not sufficient: prices, dates and percentages are formatted at
 * runtime from the Store API's numbers, so their separators and **currency symbol** appear in no
 * committed string. Brand A sells in EUR, and `Intl.NumberFormat('de-DE', { currency: 'EUR' })`
 * emits **U+20AC**. Subsetting on the catalogues alone would have put a tofu box on every price —
 * the one character that is on literally every product page.
 *
 * Derived the same way as the catalogue set: by running the formatters over sample values for the
 * brand's own locales and currency, not by listing what seems likely.
 *
 * @param {readonly string[]} locales
 * @param {readonly string[]} currencies
 */
export function runtimeCharacters(locales, currencies) {
  const chars = new Set();
  const add = (s) => {
    for (const c of s) chars.add(c);
  };
  const samples = [0, -1234.56, 1234567.89, 0.5];
  for (const locale of locales) {
    for (const value of samples) {
      add(new Intl.NumberFormat(locale).format(value));
      add(new Intl.NumberFormat(locale, { style: 'percent' }).format(value));
      for (const currency of currencies) {
        add(new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value));
      }
    }
    for (const dateStyle of ['long', 'medium', 'short']) {
      add(new Intl.DateTimeFormat(locale, { dateStyle }).format(new Date('2026-09-01')));
    }
  }
  return chars;
}

/** The locales this brand declares, from the file the running app reads. */
export function brandLocales(root = repo) {
  const config = readFileSync(path.join(root, 'apps/storefronts/brand-a/next.config.mjs'), 'utf8');
  const declared = /SUPPORTED_LOCALES\s*\?\?=\s*'([^']+)'/.exec(config)?.[1];
  // Brand A sells the starter's two and sets no override, so fall back to the same default
  // `src/i18n/locale-config.mjs` uses rather than inventing one.
  return (declared ?? 'en-GB,de-DE').split(',').map((l) => l.trim());
}

/** The currencies this brand's seeded store trades in. */
export function brandCurrencies(root = repo) {
  const seed = readFileSync(path.join(root, 'packages/db/src/seed/index.ts'), 'utf8');
  const row = seed.slice(seed.indexOf("code: 'brand-a'"));
  const currency = /currency:\s*'([A-Z]{3})'/.exec(row)?.[1];
  if (currency === undefined) {
    throw new Error('build-fonts: cannot read brand-a\u2019s currency from the seed.');
  }
  return [currency];
}

/** Every character in brand A's catalogues and committed CMS content. */
export function observedCharacters(root = repo) {
  const files = [
    ...readdirSync(path.join(root, 'apps/storefronts/brand-a/messages'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(root, 'apps/storefronts/brand-a/messages', f)),
    ...readdirSync(path.join(root, 'cms/brand-a/content'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(root, 'cms/brand-a/content', f)),
  ];
  const chars = new Set();
  const walk = (value) => {
    if (typeof value === 'string') for (const c of value) chars.add(c);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  for (const file of files) walk(JSON.parse(readFileSync(file, 'utf8')));
  return { chars, files };
}

/** The characters the shipped faces must carry: the Latin-1 floor plus whatever the brand uses. */
export function charset(root = repo) {
  const { chars } = observedCharacters(root);
  const runtime = runtimeCharacters(brandLocales(root), brandCurrencies(root));
  const set = new Set([...LATIN1, ...TYPOGRAPHIC, ...chars, ...runtime]);
  set.delete('\n');
  set.delete('\r');
  set.delete('\t');
  return [...set].sort().join('');
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** Build one face and return it with the numbers worth recording. */
export async function buildFace(face, text) {
  const source = readFileSync(path.join(SOURCE_DIR, face.source));
  const output = await subsetFont(source, text, {
    targetFormat: 'woff2',
    ...(face.variationAxes ? { variationAxes: face.variationAxes } : {}),
  });
  return {
    ...face,
    sourceBytes: source.length,
    sourceSha256: sha256(source),
    outputBytes: output.length,
    outputSha256: sha256(output),
    buffer: output,
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--charset')) {
    const { chars, files } = observedCharacters();
    const outside = [...chars]
      .filter((c) => c.trim() && !LATIN1.includes(c))
      .sort()
      .map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
    const runtime = runtimeCharacters(brandLocales(), brandCurrencies());
    const runtimeOutside = [...runtime]
      .filter((c) => c.trim() && !LATIN1.includes(c))
      .sort()
      .map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
    console.log(`scanned ${files.length} files: ${chars.size} distinct characters`);
    console.log(`outside printable Latin-1 (${outside.length}): ${outside.join(', ')}`);
    console.log(
      `Intl (${brandLocales().join(', ')} + ${brandCurrencies().join(', ')}) adds ` +
        `${runtimeOutside.length} outside Latin-1: ${runtimeOutside.join(', ') || '(none)'}`,
    );
    console.log(`charset shipped: ${charset().length} characters (Latin-1 floor + the above)`);
    return;
  }

  const text = charset();
  const built = [];
  for (const face of FACES) built.push(await buildFace(face, text));

  const check = args.includes('--check');
  let problems = 0;
  for (const face of built) {
    const target = path.join(FONT_DIR, face.output);
    const committed = statSync(target, { throwIfNoEntry: false })
      ? readFileSync(target)
      : undefined;
    if (check) {
      if (committed === undefined) {
        console.error(`build-fonts: ${face.output} is missing — run without --check.`);
        problems += 1;
      } else if (sha256(committed) !== face.outputSha256) {
        console.error(
          `build-fonts: ${face.output} is not a fresh build of ${face.source}.\n` +
            `  committed ${committed.length} bytes sha256 ${sha256(committed).slice(0, 16)}\n` +
            `  rebuilt   ${face.outputBytes} bytes sha256 ${face.outputSha256.slice(0, 16)}\n` +
            '  Regenerate with `node scripts/build-fonts.mjs` rather than editing a binary.',
        );
        problems += 1;
      }
    } else {
      mkdirSync(FONT_DIR, { recursive: true });
      writeFileSync(target, face.buffer);
    }
    const saved = face.sourceBytes - face.outputBytes;
    console.log(
      `${check ? 'checked' : 'wrote  '} ${face.output.padEnd(28)} ` +
        `${(face.outputBytes / 1024).toFixed(1).padStart(6)} kB  ` +
        `(source ${(face.sourceBytes / 1024).toFixed(1)} kB, ` +
        `-${(saved / 1024).toFixed(1)} kB, -${((saved / face.sourceBytes) * 100).toFixed(0)}%)`,
    );
  }

  const total = built.reduce((n, f) => n + f.outputBytes, 0);
  const before = built.reduce((n, f) => n + f.sourceBytes, 0);
  console.log(
    `\ntotal shipped ${(total / 1024).toFixed(1)} kB against ${(before / 1024).toFixed(1)} kB ` +
      `of sources — ${((before - total) / 1024).toFixed(1)} kB off the critical path`,
  );
  console.log(
    `at Lighthouse mobile 1.6 Mbps that is about ` +
      `${(((before - total) * 8) / 1600).toFixed(0)} ms of simulated transfer`,
  );

  if (problems > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  await main();
}
