import type { BrandTokens } from '@platform/ui';

/**
 * Brand override mechanism, part 1 of 3: design tokens.
 *
 * Anything set here wins over `defaultTokens` from `@platform/ui` and over the `theme` the Store API
 * returns, and is applied as CSS variables by `ThemeProvider` in the root layout. Set only what the
 * brand actually changes — the rest stays on the kit's defaults and keeps improving with it.
 *
 * The starter itself ships no overrides, so it renders in the kit's neutral theme.
 */
export const brandTokens: BrandTokens = {
  // color: { primary: '#1d4ed8', primaryForeground: '#ffffff' },
  // font: { sans: '"Brand Sans", ui-sans-serif, system-ui, sans-serif' },
  // radius: { md: '0.125rem' },
};
