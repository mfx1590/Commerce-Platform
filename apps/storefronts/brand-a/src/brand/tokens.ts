import type { BrandTokens } from '@platform/ui';
import { displaySerif, textSans } from './fonts';

/**
 * Brand override mechanism, part 1 of 3: design tokens.
 *
 * Anything set here wins over `defaultTokens` from `@platform/ui` and over the `theme` the Store API
 * returns, and is applied as CSS variables by `ThemeProvider` in the root layout. Set only what the
 * brand actually changes — the rest stays on the kit's defaults and keeps improving with it.
 *
 * This is brand A's theme. The reasoning, the five named colours and every measured contrast ratio
 * are in `src/brand/DESIGN.md`; that file is the authority and this one implements it. Change the
 * design there first.
 */

/**
 * The five values of DESIGN.md §2, named once so the token map below reads as the design does.
 * There is no sixth: hierarchy comes from type, space and photography.
 */
const paper = '#F7F4EF'; // warm off-white — uncoated stock, not a lit screen
const ink = '#23201B'; // warm near-black, never #000
const clay = '#9C4A32'; // the single accent: links, sale marks
const sage = '#5F6B57'; // quiet support: in-stock marks, editorial pull-outs
const stone = '#746C60'; // muted text, rules, metadata — the colour of a caption

export const brandTokens: BrandTokens = {
  color: {
    background: paper,
    foreground: ink,
    // `muted` is a surface, `mutedForeground` the text on it. Kept a shade off Paper rather than a
    // grey, so a quiet block still reads as paper.
    muted: '#EFEBE4',
    mutedForeground: stone,
    card: paper,
    cardForeground: ink,
    border: '#DFD9CF',
    input: '#DFD9CF',
    ring: ink,
    // Primary is Ink, not the accent: a black button on cream is the editorial move, and it
    // measures 14.79:1. Clay is reserved for the one warm thing on the page.
    primary: ink,
    primaryForeground: paper,
    secondary: sage,
    secondaryForeground: paper,
    accent: clay,
    accentForeground: paper,
    // Destructive and success are re-tuned into the palette's warmth rather than left on the kit's
    // stock red and green, which read as a system alert on this background.
    destructive: '#8F3A2B',
    destructiveForeground: paper,
    success: sage,
    successForeground: paper,
  },

  font: {
    // `.style.fontFamily` is the hashed family `next/font` generates plus its metric-compatible
    // fallback, so the swap does not reflow. No component ever names a family; ThemeProvider writes
    // these onto <body> as `--ui-font-sans` / `--ui-font-serif`.
    sans: textSans.style.fontFamily,
    serif: displaySerif.style.fontFamily,
  },

  lineHeight: {
    // A warm background under a humanist face wants more leading than the kit's screen default.
    normal: '1.6',
    // Newsreader's descenders clip at 1.2 in a two-line heading.
    tight: '1.25',
  },

  radius: {
    // DESIGN.md §4: rounded corners read as software; a printed page has square corners. 2px rather
    // than 0 keeps a 1px rule from looking like a rendering artefact at the corner.
    sm: '2px',
    md: '2px',
    lg: '2px',
    xl: '2px',
    // `full` is kept for the one case that needs it (an avatar).
  },

  shadow: {
    // The single biggest lever against the generic look: no floating cards. Separation is a 1px
    // Stone rule or whitespace, never a lift.
    sm: 'none',
    md: 'none',
    lg: 'none',
    xl: 'none',
  },
};
