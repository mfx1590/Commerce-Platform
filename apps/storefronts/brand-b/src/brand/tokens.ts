import type { BrandTokens } from '@platform/ui';

/**
 * Brand override mechanism, part 1 of 3: design tokens.
 *
 * Anything set here wins over `defaultTokens` from `@platform/ui` and over the `theme` the Store API
 * returns, and is applied as CSS variables by `ThemeProvider` in the root layout. Set only what the
 * brand actually changes — the rest stays on the kit's defaults and keeps improving with it.
 *
 * **Brand B is deliberately a lighter theme than brand A's.** A ships its own font files
 * (`src/brand/fonts/`) and a full token set; B sets a palette, a system font stack and its radii,
 * and takes the kit's defaults for everything else. That is not laziness — it is the second data
 * point for #438, and `ONBOARDING-GAPS.md` records which of A's extras a new brand actually needs
 * (a licensed font is a purchase and a decision, not a file copy).
 */

/**
 * Stonecrop's palette. Cooler and harder than brand A's warm paper-and-clay: a chalk ground, slate
 * text, a moss accent, with brick kept for destructive states only so the accent never competes
 * with a warning.
 */
const chalk = '#f6f7f5';
const slate = '#24292c';
const moss = '#4a6b4f';
const mist = '#dfe3df';
const brick = '#9c3b2e';

export const BRAND_PALETTE = {
  named: { Chalk: chalk, Slate: slate, Moss: moss, Mist: mist, Brick: brick },
  derived: {
    muted: '#eceeea',
    border: mist,
    input: mist,
    destructive: brick,
  },
} as const;

export const brandTokens: BrandTokens = {
  color: {
    background: chalk,
    foreground: slate,
    primary: moss,
    primaryForeground: chalk,
    muted: BRAND_PALETTE.derived.muted,
    mutedForeground: '#5c6560',
    border: BRAND_PALETTE.derived.border,
    input: BRAND_PALETTE.derived.input,
    destructive: BRAND_PALETTE.derived.destructive,
    destructiveForeground: chalk,
  },
  font: {
    // A system stack on purpose: no font binaries ship with this brand, so there is no licence to
    // track and no render-blocking download. The LCP lesson from #348 applies — brand A's hero LCP
    // was render-delay bound, and a webfont is the easiest way to make that worse.
    sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  radius: {
    // Squarer than the kit's default: B's product photography is cropped square.
    sm: '0.125rem',
    md: '0.1875rem',
    lg: '0.25rem',
  },
};
