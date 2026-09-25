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
const { brandTokens } = await import('@/brand/tokens');

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
  it('is the five named values of DESIGN.md §2 and no sixth accent', () => {
    // Paper, Ink, Clay, Sage, Stone. `muted`, `border` and `input` are tints of Paper, and
    // destructive is a warmed Clay — none of them introduce a new hue.
    expect(color.background).toBe('#F7F4EF'); // Paper
    expect(color.foreground).toBe('#23201B'); // Ink
    expect(color.accent).toBe('#9C4A32'); // Clay
    expect(color.secondary).toBe('#5F6B57'); // Sage
    expect(color.mutedForeground).toBe('#746C60'); // Stone
  });

  it('uses Ink for primary, not the accent — a black button on cream', () => {
    expect(color.primary).toBe(color.foreground);
    expect(color.primaryForeground).toBe(color.background);
  });

  it.each([
    ['body text', 'foreground', 'background', 7],
    ['primary button label', 'primaryForeground', 'primary', 7],
    ['links / accent text', 'accent', 'background', 4.5],
    ['sage on paper', 'secondary', 'background', 4.5],
    ['muted text', 'mutedForeground', 'background', 4.5],
    ['label on a clay block', 'accentForeground', 'accent', 4.5],
    ['label on a sage block', 'secondaryForeground', 'secondary', 4.5],
    ['destructive label', 'destructiveForeground', 'destructive', 4.5],
  ] as const)('clears WCAG AA for %s', (_what, fg, bg, target) => {
    const ratio = contrast(color[fg] as string, color[bg] as string);
    expect(ratio).toBeGreaterThanOrEqual(target);
  });

  it('publishes the exact ratios DESIGN.md §2 claims', () => {
    const round = (n: number) => Number(n.toFixed(2));
    expect(round(contrast('#23201B', '#F7F4EF'))).toBe(14.79); // Ink on Paper
    expect(round(contrast('#9C4A32', '#F7F4EF'))).toBe(5.57); // Clay on Paper
    expect(round(contrast('#5F6B57', '#F7F4EF'))).toBe(5.14); // Sage on Paper
    expect(round(contrast('#746C60', '#F7F4EF'))).toBe(4.72); // Stone on Paper
  });

  it('keeps Stone above the 4.5 floor it originally failed', () => {
    // It shipped as #7A7266 in the first draft and measured 4.32:1. Regression guard.
    expect(contrast('#7A7266', '#F7F4EF')).toBeLessThan(4.5);
    expect(contrast(color.mutedForeground as string, '#F7F4EF')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('brand A shape and depth (DESIGN.md §4)', () => {
  it('collapses radius — a printed page has square corners', () => {
    expect(brandTokens.radius).toMatchObject({ sm: '2px', md: '2px', lg: '2px', xl: '2px' });
  });

  it('keeps radius.full on the kit default, for the one case that needs it', () => {
    expect(brandTokens.radius?.full).toBeUndefined();
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
