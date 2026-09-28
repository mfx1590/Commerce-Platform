import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

/**
 * `next/font/local` is a build-time construct: the webpack loader rewrites the call, and the module
 * has no runtime implementation to import. Every unit test that reaches `tokens.ts` therefore has to
 * stand one in. The mock records what `fonts.ts` asks for, which is what the type tests below
 * assert; that the faces then actually load is a property of the build, verified against the build
 * output and the served HTML, not here.
 */
const localFontCalls: {
  src: { path: string; weight: string; style: string }[];
  display: string;
  fallback: string[];
}[] = [];

vi.mock('next/font/local', () => ({
  default: (options: never) => {
    localFontCalls.push(options);
    const family = `__mock_${localFontCalls.length}`;
    return { className: family, style: { fontFamily: family }, variable: `--${family}` };
  },
}));

const { brandConfig, siteUrl } = await import('@/brand/config');
const { displaySerif, textSans } = await import('@/brand/fonts');
const { BRAND_PALETTE, brandTokens } = await import('@/brand/tokens');

/**
 * Brand A's theme, held to `src/brand/DESIGN.md`.
 *
 * The contrast block below is the point of this file: DESIGN.md §2 publishes a table of measured
 * ratios, and a published number that nothing checks rots the moment someone nudges a hex. These
 * tests recompute the ratios from the tokens that actually ship, so the design document and the
 * implementation cannot drift apart silently.
 */

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const channels = (hex.replace('#', '').match(/../g) ?? []).map((pair) => {
    const c = parseInt(pair, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio, order-independent. */
function contrast(a: string, b: string): number {
  const [lighter = 0, darker = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

const color = brandTokens.color ?? {};

describe('brand A palette', () => {
  it('is the five named hues of DESIGN.md §2', () => {
    expect(color.background).toBe('#F7F4EF'); // Paper
    expect(color.foreground).toBe('#23201B'); // Ink
    expect(color.accent).toBe('#9C4A32'); // Clay
    expect(color.secondary).toBe('#5F6B57'); // Sage
    expect(color.mutedForeground).toBe('#6B6357'); // Stone
  });

  /**
   * The single-source guard. `tokens.ts` exports `BRAND_PALETTE`; DESIGN.md §2 prints two tables.
   * These tests read both and assert they agree **in both directions**, so neither can be edited
   * alone.
   *
   * The previous version compared the tokens against a Set of hex literals written into this file,
   * which review called drift with extra steps — correctly: that Set was a third copy of the
   * palette, so changing §2 by itself still passed. Nothing here restates a colour.
   */
  const design = readFileSync(new URL('../src/brand/DESIGN.md', import.meta.url), 'utf8');

  /** `| **Paper** | \`#F7F4EF\` | …` — the "The five" table. */
  const namedInDesign = new Map(
    [...design.matchAll(/^\|\s*\*\*(\w+)\*\*\s*\|\s*`(#[0-9A-Fa-f]{6})`\s*\|/gm)].map((m) => [
      m[1] as string,
      m[2] as string,
    ]),
  );

  /** `| \`muted\` | \`#EFEBE4\` | …` — the "The four derived" table. */
  const derivedInDesign = new Map(
    [...design.matchAll(/^\|\s*`(\w+)`\s*\|\s*`(#[0-9A-Fa-f]{6})`\s*\|/gm)].map((m) => [
      m[1] as string,
      m[2] as string,
    ]),
  );

  it('§2 "The five" quotes exactly the five the tokens export', () => {
    expect(Object.fromEntries(namedInDesign)).toEqual(BRAND_PALETTE.named);
  });

  it('§2 "The four derived" quotes exactly the four the tokens export', () => {
    expect(Object.fromEntries(derivedInDesign)).toEqual(BRAND_PALETTE.derived);
  });

  it('ships no colour token whose hex §2 does not name', () => {
    const documented = new Set<string>([
      ...Object.values(BRAND_PALETTE.named),
      ...Object.values(BRAND_PALETTE.derived),
    ]);
    // Every documented value must also actually appear in DESIGN.md, so the export cannot drift by
    // itself either — this is the direction the old test could not see.
    for (const hex of documented) expect(design).toContain(hex);

    const undocumented = Object.entries(color).filter(([, v]) => !documented.has(v as string));
    expect(undocumented).toEqual([]);
  });

  it('parsed something — a regex that matches nothing would pass every test above', () => {
    expect(namedInDesign.size).toBe(5);
    expect(derivedInDesign.size).toBe(4);
  });

  it('uses Ink for primary, not the accent — a black button on cream', () => {
    expect(color.primary).toBe(color.foreground);
    expect(color.primaryForeground).toBe(color.background);
  });

  /**
   * The surface matrix. Review caught Stone failing on `muted` (4.36:1) because the first version of
   * this suite only checked text against the page — and Lighthouse only audits the PLP and PDP,
   * where the neutral Badge and the CMS hero eyebrow do not appear. Every text token is now checked
   * against every surface it can actually land on, so a passing page cannot hide a failing block.
   */
  const SURFACES = ['background', 'muted', 'card'] as const;
  const TEXT_ON_ANY_SURFACE = ['foreground', 'mutedForeground', 'accent', 'secondary'] as const;

  for (const fg of TEXT_ON_ANY_SURFACE) {
    for (const bg of SURFACES) {
      it(`clears WCAG AA: ${fg} on ${bg}`, () => {
        expect(contrast(color[fg] as string, color[bg] as string)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it.each([
    ['primary button label', 'primaryForeground', 'primary', 7],
    ['label on a clay block', 'accentForeground', 'accent', 4.5],
    ['label on a sage block', 'secondaryForeground', 'secondary', 4.5],
    ['destructive label', 'destructiveForeground', 'destructive', 4.5],
  ] as const)('clears WCAG AA for %s', (_what, fg, bg, target) => {
    expect(contrast(color[fg] as string, color[bg] as string)).toBeGreaterThanOrEqual(target);
  });

  it('gives form fields a 3:1 boundary on every surface (WCAG 1.4.11)', () => {
    // `input` is the edge of a text field, which identifies a UI component; `border` is decorative
    // rules and is exempt. They are different values for exactly this reason (DESIGN.md §2).
    expect(color.input).not.toBe(color.border);
    for (const bg of SURFACES) {
      expect(contrast(color.input as string, color[bg] as string)).toBeGreaterThanOrEqual(3);
    }
  });

  it('publishes the exact ratios DESIGN.md §2 claims', () => {
    const round = (n: number) => Number(n.toFixed(2));
    expect(round(contrast('#23201B', '#F7F4EF'))).toBe(14.79); // Ink on Paper
    expect(round(contrast('#9C4A32', '#F7F4EF'))).toBe(5.57); // Clay on Paper
    expect(round(contrast('#5F6B57', '#F7F4EF'))).toBe(5.14); // Sage on Paper
    expect(round(contrast('#6B6357', '#F7F4EF'))).toBe(5.4); // Stone on Paper
    expect(round(contrast('#6B6357', '#EFEBE4'))).toBe(4.98); // Stone on muted
    expect(round(contrast('#8F8676', '#F7F4EF'))).toBe(3.28); // input on Paper
    expect(round(contrast('#8F3A2B', '#F7F4EF'))).toBe(6.82); // destructive on Paper
  });

  it('keeps Stone above the floor it failed twice', () => {
    // #7A7266 failed on Paper (4.32:1); #746C60 passed Paper but failed `muted` (4.36:1).
    expect(contrast('#7A7266', '#F7F4EF')).toBeLessThan(4.5);
    expect(contrast('#746C60', '#EFEBE4')).toBeLessThan(4.5);
    expect(contrast(color.mutedForeground as string, '#F7F4EF')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color.mutedForeground as string, '#EFEBE4')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('brand A shape and depth (DESIGN.md §4)', () => {
  it('collapses every radius step — a printed page has square corners', () => {
    // `full` included: it is what `rounded-full` resolves to, its only user in the kit is `Badge`,
    // and no avatar component exists to need a circle (DESIGN.md §4).
    expect(brandTokens.radius).toEqual({
      sm: '2px',
      md: '2px',
      lg: '2px',
      xl: '2px',
      full: '2px',
    });
  });

  it('removes every shadow — no floating cards', () => {
    expect(Object.values(brandTokens.shadow ?? {})).toEqual(['none', 'none', 'none', 'none']);
  });
});

describe('brand A type (DESIGN.md §3)', () => {
  it('sets both families from the self-hosted faces', () => {
    expect(brandTokens.font?.sans).toBe(textSans.style.fontFamily);
    expect(brandTokens.font?.serif).toBe(displaySerif.style.fontFamily);
    expect(brandTokens.font?.sans).not.toBe(brandTokens.font?.serif);
  });

  it('loads both faces from woff2 committed inside src/brand — never from a CDN', () => {
    expect(localFontCalls).toHaveLength(2);
    for (const call of localFontCalls) {
      const [face] = call.src;
      expect(face?.path).toMatch(/^\.\/fonts\/[a-z-]+\.woff2$/);
      expect(face?.path).not.toMatch(/gstatic|googleapis|https?:/i);
      // Swap, so text is readable while the face arrives...
      expect(call.display).toBe('swap');
      // ...and a real fallback stack behind it, so the swap does not reflow into nothing.
      expect(call.fallback.length).toBeGreaterThan(1);
    }
  });

  it('covers the weight range the design uses, on one variable file per face', () => {
    expect(localFontCalls.map((c) => c.src.length)).toEqual([1, 1]);
    expect(localFontCalls.map((c) => c.src[0]?.weight)).toEqual(['400 700', '300 700']);
  });

  it('relaxes leading for a warm background, and unclips two-line headings', () => {
    expect(brandTokens.lineHeight).toEqual({ normal: '1.6', tight: '1.25' });
  });
});

describe('brand A share card and favicon (#140 favicon/OG defaults)', () => {
  const root = new URL('../src/app/', import.meta.url);

  it('draws the share card in the brand palette, not the kit neutral', async () => {
    const source = await readFile(new URL('opengraph-image.tsx', root), 'utf8');
    // The card cannot import tokens.ts (it would pull next/font into an image route), so it repeats
    // the hex. This is the guard that the copies stay in step with the tokens.
    expect(source).toContain(`'${color.background as string}'`); // Paper
    expect(source).toContain(`'${color.foreground as string}'`); // Ink
    expect(source).toContain(`'${color.accent as string}'`); // Clay
    expect(source).toContain(`'${color.mutedForeground as string}'`); // Stone
    // The starter's product card is hard-coded to the kit's dark neutral; brand A's must not be.
    expect(source).not.toMatch(/#0b0b0c|#fafafa/i);
  });

  it('ships a favicon that needs no webfont and uses the brand values', async () => {
    const svg = await readFile(new URL('icon.svg', root), 'utf8');
    expect(svg).toContain(color.foreground as string);
    expect(svg).toContain(color.background as string);
    // A <text> element would depend on a font being present in the rendering context.
    expect(svg).not.toContain('<text');
  });
});

describe('brand A identity (DESIGN.md §1, mechanism #254)', () => {
  it('names the brand, so the title template is in <head> without an API call', () => {
    expect(brandConfig.name).toBe('Fieldnote');
    expect(brandConfig.description.length).toBeGreaterThan(0);
    // Metadata ships in the HTML; nothing here may be secret or customer-derived.
    expect(brandConfig.description).not.toMatch(/@|\bpk_|\bsk_/);
  });

  it('leaves the canonical origin to SITE_URL, so one image serves staging and production', () => {
    expect(brandConfig.siteUrl).toBeUndefined();
    expect(siteUrl({ SITE_URL: 'https://fieldnote.example/' })).toBe('https://fieldnote.example');
  });
});
