import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FACES,
  brandCurrencies,
  brandLocales,
  charset,
  observedCharacters,
  runtimeCharacters,
} from '../scripts/build-fonts.mjs';

/**
 * Brand A's shipped faces are GENERATED, and this file is what stops them drifting (#739).
 *
 * `scripts/build-fonts.mjs` derives them from the committed OFL variable sources. A generated binary
 * in a repo is only trustworthy if something proves it is still a build of its source, so the
 * `--check` test below rebuilds and compares hashes. Without it, "regenerate the fonts" is a step a
 * future change can skip and nobody notices until a glyph is missing in production.
 */

const APP = join(import.meta.dirname, '..');
const FONTS = join(APP, 'src', 'brand', 'fonts');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('brand A generated faces (#739)', () => {
  it('the committed faces are a fresh build of the committed sources', () => {
    // The load-bearing assertion. `--check` exits non-zero and names the file when a committed
    // woff2 is not what the script produces from `fonts/source/`, so a hand-edited or stale binary
    // cannot pass review.
    const out = execFileSync(process.execPath, ['scripts/build-fonts.mjs', '--check'], {
      cwd: APP,
      encoding: 'utf8',
    });
    expect(out).toMatch(/checked/);
    expect(out).not.toMatch(/not a fresh build|is missing/);
  });

  it('ships every face its sources define, and nothing else', () => {
    const shipped = readdirSync(FONTS).filter((f) => f.endsWith('.woff2'));
    expect(shipped.sort()).toEqual(FACES.map((f) => f.output).sort());
  });

  it('keeps the sources, with their licences, so the build is reproducible from the repo', () => {
    const source = readdirSync(join(FONTS, 'source'));
    for (const face of FACES) expect(source).toContain(face.source);
    // SIL OFL 1.1 requires the licence to travel with the font; both faces are OFL.
    expect(source.filter((f) => f.startsWith('OFL-'))).toHaveLength(FACES.length);
  });

  it('is smaller than its sources — the whole point of the exercise', () => {
    for (const face of FACES) {
      const src = readFileSync(join(FONTS, 'source', face.source));
      const out = readFileSync(join(FONTS, face.output));
      expect(out.length).toBeLessThan(src.length);
    }
    const shipped = FACES.reduce((n, f) => n + readFileSync(join(FONTS, f.output)).length, 0);
    // 90.6 kB before; the budget argument in DESIGN.md turns on this staying well under it.
    expect(shipped).toBeLessThan(60 * 1024);
  });

  it('pins the serif to the one weight theme.css asks for', () => {
    const serif = FACES.find((f) => f.source.includes('newsreader'));
    expect(serif?.variationAxes).toEqual({ wght: 500 });
    // ...and theme.css is where that 500 comes from, so the two cannot drift apart silently.
    const theme = readFileSync(join(APP, 'src', 'brand', 'theme.css'), 'utf8');
    expect(theme).toMatch(/font-weight:\s*var\(--ui-font-weight-medium\)/);
  });

  it('keeps the sans range the kit actually renders, 400 to 700', () => {
    const sans = FACES.find((f) => f.source.includes('hanken'));
    expect(sans?.variationAxes).toEqual({ wght: { min: 400, max: 700 } });
  });
});

describe('medium serif headings are ENFORCED, not aspirational (#765 review)', () => {
  const theme = () => readFileSync(join(APP, 'src', 'brand', 'theme.css'), 'utf8');

  it('declares each face at the weight its generated file actually contains', () => {
    // The silent half of the regression: fonts.ts said `'400 700'` while the file held only 500, so
    // the browser believed 700 was available and never reached for anything else.
    const fonts = readFileSync(join(APP, 'src', 'brand', 'fonts.ts'), 'utf8');
    expect(fonts).toMatch(/newsreader-latin\.woff2',\s*weight:\s*'500'/);
    expect(fonts).toMatch(/hanken-grotesk-latin\.woff2',\s*weight:\s*'400 700'/);
    expect(fonts).not.toMatch(/weight:\s*'300 700'/);
  });

  it('out-specifies the synced font-bold/font-semibold utilities on serif headings', () => {
    // `h1` is (0,0,1) and `.font-bold` is (0,1,0), so an element rule alone LOSES — which is how 33
    // headings rendered 700/600 for brand A's whole life while DESIGN.md said medium. `h1[class]`
    // is (0,1,1) and wins without `!important`.
    const css = theme();
    for (const tag of ['h1', 'h2', 'h3', 'h4']) {
      expect(css, `${tag}[class] must out-specify a weight utility`).toContain(`${tag}[class]`);
    }
    const guarded = css.slice(css.indexOf('h1[class]'));
    expect(guarded).toMatch(/font-weight:\s*var\(--ui-font-weight-medium\)/);
  });

  it('forbids synthetic bold on the serif, without disabling synthetic italic', () => {
    // A request for 700 against a 500-only face would otherwise be answered with a smeared outline.
    const css = theme();
    expect(css).toMatch(/^\s*font-synthesis-weight:\s*none/m);
    // NOT the shorthand, which also kills synthetic italic: brand A ships no italic face, so every
    // <em> would quietly render upright. Line-anchored, because theme.css's own comment explains
    // the distinction in prose and an unanchored match found that instead of a declaration — which
    // is exactly the kind of test that passes while asserting nothing.
    expect(css).not.toMatch(/^\s*font-synthesis:\s*none/m);
  });

  it('still covers headings that carry no class at all', () => {
    const css = theme();
    const base = css.slice(0, css.indexOf('h1[class]'));
    expect(base).toMatch(/^h1,\s*$/m);
    expect(base).toMatch(/font-weight:\s*var\(--ui-font-weight-medium\)/);
  });
});

describe('the charset is derived, not guessed (#739)', () => {
  it('keeps printable Latin-1 as the floor, for content this repo has never seen', () => {
    // Product and category names come from the Store API at runtime. Subsetting to only the
    // characters in today's catalogues renders a tofu box the first time a product is called
    // "Café", which is why the floor is not negotiable for a few kB.
    const set = charset();
    for (const c of ['A', 'z', '0', '£', 'é', 'ü', 'ß', 'Ø', 'ñ']) expect(set).toContain(c);
  });

  it('carries the typographic marks the brand actually writes with', () => {
    const { chars } = observedCharacters();
    // U+201E is the one a guess misses: de-DE opens a quotation with the low-9 mark.
    expect(chars).toContain('„');
    for (const c of ['—', '“', '”', '„']) expect(charset()).toContain(c);
  });

  it('carries the currency symbol no catalogue can contain', () => {
    // The catch that would have broken every price: prices are formatted by Intl from Store API
    // numbers, so the euro sign appears in no committed string. It is on every product page.
    const { chars } = observedCharacters();
    expect(chars.has('€')).toBe(false);
    expect(runtimeCharacters(brandLocales(), brandCurrencies())).toContain('€');
    expect(charset()).toContain('€');
  });

  it('derives the locales and the currency from the brand, not from a literal here', () => {
    expect(brandLocales()).toEqual(['en-GB', 'de-DE']);
    // From packages/db's seed, so the font and the store cannot disagree about what A sells.
    expect(brandCurrencies()).toEqual(['EUR']);
  });

  it('is small enough to be worth subsetting at all', () => {
    // Sanity, not a budget: the floor plus the brand's own marks, nowhere near a full Latin range.
    expect(charset().length).toBeGreaterThan(150);
    expect(charset().length).toBeLessThan(260);
  });
});

describe('provenance', () => {
  it('records each source hash, so a swapped binary is visible in the diff', () => {
    const readme = readFileSync(join(FONTS, 'README.md'), 'utf8');
    for (const face of FACES) {
      const src = readFileSync(join(FONTS, 'source', face.source));
      expect(readme, `${face.source} hash in fonts/README.md`).toContain(sha256(src).slice(0, 16));
    }
  });

  it('records the tool that generated them, at the version that is installed', () => {
    const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));
    const version = pkg.devDependencies?.['subset-font'];
    expect(version, 'subset-font must be a brand A devDependency').toBeDefined();
    // Exact, not a range: a generated binary has to be reproducible by whoever reads this.
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readFileSync(join(FONTS, 'README.md'), 'utf8')).toContain(`subset-font@${version}`);
  });
});
