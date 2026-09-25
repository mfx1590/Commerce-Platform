# Brand A — design

Task 2.2 (#140). Window 10 (brands).

There is no Figma for brand A and none is coming. This file is the design: it is written before the
code and the code is held to it. If a later task wants to change the look, it changes this file
first and says why.

---

## 1. What brand A is

A direct-to-consumer apparel label selling in the EU (EUR, `en-GB` + `de-DE`). Small considered
range, a few drops a year, garments meant to be kept. The nearest reference points are the printed
lookbook and the broadsheet fashion supplement — not the marketplace and not the app.

The three adjectives the design has to earn, in priority order:

1. **Calm** — nothing moves, flashes, or competes for attention. Emptiness is the default state.
2. **Editorial** — the page reads like a printed page: a clear text column, real typographic
   hierarchy, generous margins, photography given room rather than cropped into a grid cell.
3. **Material** — warm and paper-like, not screen-like. Off-white rather than `#ffffff`, warm
   near-black rather than `#000000`.

### What it is explicitly not

- **Not the admin's Medusa rail.** That surface is dark, dense, operator-facing, and optimised for
  people who look at it for eight hours. Brand A is light, sparse, customer-facing, and optimised
  for people who look at it for ninety seconds. They share a repository and share no visual DNA.
- **Not the generic AI storefront.** No purple or indigo gradients, no glassmorphism, no frosted
  cards, no blur-behind anything, no full-bleed hero with a centred headline over a darkened stock
  photograph, no pill buttons with a gradient fill, no drop shadows used as decoration. Every one of
  these is a house style with no author. Brand A has an author.

---

## 2. Colour — five values

Five, named, and no sixth. A palette this small forces hierarchy to come from type, space, and
photography, which is what makes the result read as editorial rather than as a theme.

| Name      | Hex       | Role                                                                     |
| --------- | --------- | ------------------------------------------------------------------------ |
| **Paper** | `#F7F4EF` | Page background. Warm off-white — uncoated stock, not a lit screen.      |
| **Ink**   | `#23201B` | Body text, headings, primary buttons. Warm near-black, never `#000`.      |
| **Clay**  | `#9C4A32` | The single accent. Links, sale marks, the one thing allowed to be warm.  |
| **Sage**  | `#5F6B57` | Quiet support: in-stock marks, secondary blocks, editorial pull-outs.    |
| **Stone** | `#746C60` | Muted text, borders, rules, metadata. The colour of a caption.            |

The hue story is deliberate: Paper, Ink, Clay and Stone all sit in the warm half of the wheel, and
Sage is the one cool note. That is the palette of a linen swatch card, which is the point.

### Measured contrast (WCAG 2.1, computed — not estimated)

| Pair                     | Ratio      | Target | Result |
| ------------------------ | ---------- | ------ | ------ |
| Ink on Paper (body)      | **14.79:1** | 7.0   | pass   |
| Paper on Ink (button)    | **14.79:1** | 7.0   | pass   |
| Clay on Paper (links)    | **5.57:1**  | 4.5   | pass   |
| Sage on Paper            | **5.14:1**  | 4.5   | pass   |
| Stone on Paper (muted)   | **4.72:1**  | 4.5   | pass   |
| Paper on Clay (block)    | **5.57:1**  | 4.5   | pass   |
| Paper on Sage (block)    | **5.14:1**  | 4.5   | pass   |

Stone started at `#7A7266` and measured 4.32:1 — a fail. It was darkened to `#746C60` rather than
kept as a "close enough" caption grey. Clay and Sage clear AA as text and are still legible when
used the other way round, as a block with Paper on top, so neither is limited to one direction.

Nothing in the palette relies on colour alone to carry meaning: an out-of-stock mark is Stone text
that says so, not a grey dot.

---

## 3. Type — a self-hosted pairing

**Newsreader** for display, **Hanken Grotesk** for text and UI. Both SIL Open Font License 1.1.

- **Newsreader** (Production Type) is a genuine editorial text serif with optical sizing — it was
  drawn for reading, not for logos, so it stays calm at 40px where a display serif would shout. It
  carries headings, the product name on the PDP, and pull quotes.
- **Hanken Grotesk** is a humanist grotesque that is quiet at 14–16px and has the figure set a price
  and a size chart need. It carries body copy, navigation, labels, and every control.

The pairing is a serif voice over a neutral ground, which is the broadsheet relationship. It is
deliberately **not** Inter, and deliberately not the wonky-serif-plus-geometric combination that has
become the indie D2C default.

**Self-hosted, never fetched at runtime.** The `woff2` files are committed under `src/brand/fonts/`
and loaded with `next/font/local`, following the precedent set by `apps/admin/src/app/fonts.ts`.
Three reasons: the build stays hermetic (CI and the image build never need the network), there is no
request to `fonts.gstatic.com` on a customer's first paint, and no third party learns who is reading
the page. Latin subsets only — brand A sells in `en-GB` and `de-DE`, both of which the Latin subset
covers, including the umlauts and the eszett that `de-DE` needs.

### Scale

The starter's `fontSize` ramp is kept — the brand does not need its own — with two overrides:
`lineHeight.normal` relaxes from `1.5` to `1.6` because a warm background with a 15px humanist face
reads better with more leading, and `lineHeight.tight` loosens from `1.2` to `1.25` so Newsreader's
descenders are not clipped in two-line headings.

---

## 4. Shape and depth

- **Radius: effectively none.** `sm`, `md` and `lg` all collapse to `2px`; `full` is kept for the one
  case that needs it (an avatar). Rounded corners read as software. A printed page has square
  corners and so does this one.
- **Shadow: none.** All four shadow tokens become `none`. Separation is done with a 1px Stone rule
  or with whitespace, never with a float. This is the single biggest lever against the generic look
  — it removes the card-floating-on-a-grid idiom in one move.

Depth in brand A is created by the amount of empty space around a thing, not by lifting it.

---

## 5. Mechanism — how the theme is applied

Everything in this design ships through `src/brand/**` and nothing else. The rest of `src/**` stays
byte-identical to `apps/storefront-starter`, so `pnpm --filter @platform/storefront-brand-a sync`
stays a reviewable diff (the 2.1 decision, ADR 0004).

| File                        | Carries                                                       |
| --------------------------- | ------------------------------------------------------------- |
| `src/brand/fonts.ts`        | The two `next/font/local` faces and their fallbacks.           |
| `src/brand/fonts/*.woff2`   | The font binaries and their OFL licence texts.                 |
| `src/brand/tokens.ts`       | Colour, font family, line height, radius and shadow overrides. |
| `src/brand/config.ts`       | Name, description and canonical origin for metadata (#254).    |

**Why the fonts are wired through `tokens.ts` and not through a slot.** The obvious place to inject
`@font-face` is a component — but the only always-present slots are `Header` and `Footer`, and the
checkout and account layouts do not render the header. A font that only loads where the header
renders would drop out at exactly the step that matters most. `tokens.ts` is imported by the root
`[locale]/layout.tsx`, so the CSS `next/font` emits for it is in the root layout's chunk and is
linked from `<head>` on every route, checkout included. The font family reaches the page the same
way every other token does: `ThemeProvider` writes it onto `<body>` as `--ui-font-sans`.

This also means no component anywhere names a font family, which is the rule the kit already sets.

**What is left on the API.** `store.theme` still wins where it is set — the brand tokens are the
default, not a lock. Prices, availability, locales and content keep coming from the Store API. This
file describes how brand A looks, not what it sells.

---

## 6. Accessibility and performance commitments

- Every text pair in §2 is measured above and clears WCAG AA; the body pair clears AAA.
- `:focus-visible` keeps the starter's 2px ring, re-coloured to Ink so it is visible on Paper.
- `font-display: swap` on both faces, with a metric-compatible fallback so the swap does not reflow.
- The display face is preloaded; the text face is preloaded. Nothing else is.
- No token in this design adds a network request, an animation, or a blocking script.
