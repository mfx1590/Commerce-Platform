import type { BrandTokens } from '@platform/ui';
import { displaySerif, textSans } from './fonts';
// One rule, so the display face actually reaches headings — see the file's own comment.
import './theme.css';

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
 * The five named hues of DESIGN.md §2, named once so the token map below reads as the design does.
 * No sixth *hue*: hierarchy comes from type, space and photography. Four derived neutrals and
 * states (`muted`, `border`, `input`, `destructive`) do ship as their own hex values below; §2
 * lists each with its measured ratio, rather than pretending the palette is five literals.
 */
const paper = '#F7F4EF'; // warm off-white — uncoated stock, not a lit screen
const ink = '#23201B'; // warm near-black, never #000
const clay = '#9C4A32'; // the single accent: links, sale marks
const sage = '#5F6B57'; // quiet support: in-stock marks, editorial pull-outs
const stone = '#6B6357'; // muted text, rules, metadata — the colour of a caption

export const brandTokens: BrandTokens = {
  color: {
    background: paper,
    foreground: ink,
    // Derived neutrals. DESIGN.md §2 names them and states each one's measured ratio — they are
    // tints of Paper and Stone, not new hues, but they do ship as their own hex values.
    //
    // `muted` is a surface, `mutedForeground` the text on it. A shade off Paper rather than a grey,
    // so a quiet block still reads as paper. Stone on it measures 4.98:1.
    muted: '#EFEBE4',
    mutedForeground: stone,
    card: paper,
    cardForeground: ink,
    // `border` draws decorative hairline rules — a divider carries no information a sighted user
    // needs to identify a control, so WCAG 1.4.11 does not apply to it (1.28:1 against Paper).
    border: '#DFD9CF',
    // `input` is NOT the same value, and that is deliberate. It draws the boundary of a text field,
    // which *is* a user-interface component under WCAG 1.4.11 and needs 3:1 — the whole checkout is
    // form fields. It measures 3.28:1 on Paper and 3.03:1 on `muted`. Sharing one light value with
    // `border` (as the kit's defaults do) leaves every field edge effectively invisible.
    input: '#8F8676',
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
    // `full` too, which review prompted and which turned out to be the only thing still rounding a
    // corner in this app. `rounded-full` resolves to this token, its only user in @platform/ui is
    // `Badge`, and there is no avatar component anywhere — so the "kept for avatars" exemption an
    // earlier draft of DESIGN.md claimed was protecting nothing and rounding the one component it
    // did reach. If brand A ever needs a real circle, it asks the kit for an `Avatar` whose shape
    // does not ride on the shared radius scale.
    full: '2px',
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
