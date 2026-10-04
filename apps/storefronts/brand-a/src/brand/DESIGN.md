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

The working name is **Fieldnote** — it is what `brandConfig.name` says, so it is the title
template, the Open Graph site name and the word in the tab. A store's display name can still come
from the API for the parts of the page that render store data; the name here is the one that has to
be in the HTML before any request resolves (§5).

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

## 2. Colour

**Five named hues, and four derived values that the code also ships.** An earlier draft of this
section said "five, named, and no sixth" while `tokens.ts` shipped nine hex literals. That was a
drifting document, which is worse than either honest option, so this section now owns everything the
code sets. The _hue_ discipline is real and unchanged: five colours, one accent, hierarchy from type
and space. What follows is not a sixth colour — it is Paper and Stone at other lightnesses, plus one
state colour.

### The five

| Name      | Hex       | Role                                                                    |
| --------- | --------- | ----------------------------------------------------------------------- |
| **Paper** | `#F7F4EF` | Page background. Warm off-white — uncoated stock, not a lit screen.     |
| **Ink**   | `#23201B` | Body text, headings, primary buttons. Warm near-black, never `#000`.    |
| **Clay**  | `#9C4A32` | The single accent. Links, sale marks, the one thing allowed to be warm. |
| **Sage**  | `#5F6B57` | Quiet support: in-stock marks, secondary blocks, editorial pull-outs.   |
| **Stone** | `#6B6357` | Muted text, metadata. The colour of a caption.                          |

The hue story is deliberate: Paper, Ink, Clay and Stone all sit in the warm half of the wheel, and
Sage is the one cool note. That is the palette of a linen swatch card, which is the point.

### The four derived

| Token         | Hex       | Derived from   | Why it has to exist                                                    | Measured                                   |
| ------------- | --------- | -------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| `muted`       | `#EFEBE4` | Paper, darker  | A quiet block needs a surface. A grey here would break the paper feel. | Stone on it **4.98:1**                     |
| `border`      | `#DFD9CF` | Paper, darker  | Decorative hairline rules and dividers.                                | 1.28:1 vs Paper — see below                |
| `input`       | `#8F8676` | Stone, lighter | The boundary of a text field.                                          | **3.28:1** vs Paper, **3.03:1** vs `muted` |
| `destructive` | `#8F3A2B` | Clay, deeper   | An error state. The kit's stock red reads as a system alert on Paper.  | **6.82:1** vs Paper                        |

**`border` and `input` are deliberately different values, and the split is an accessibility
decision, not a visual one.** WCAG 1.4.11 (Non-text Contrast) requires 3:1 for visual information
needed to _identify a user-interface component_. A divider rule carries no such information, so
`border` is free to be a true hairline at 1.28:1. The edge of a text field does identify a control —
and brand A's entire checkout is text fields — so `input` is a separate, darker value that clears
3:1 on both surfaces it can sit on. The kit's defaults use one light value for both, which leaves
field edges effectively invisible; brand A does not inherit that.

### Measured contrast (WCAG 2.1, computed — not estimated)

Every pair below is recomputed from the shipping tokens in `test/brand-theme.test.ts`, including
each text token against **every surface it can land on** rather than only against the page.

| Pair                          | Ratio       | Target | Result |
| ----------------------------- | ----------- | ------ | ------ |
| Ink on Paper (body)           | **14.79:1** | 7.0    | pass   |
| Paper on Ink (primary button) | **14.79:1** | 7.0    | pass   |
| Clay on Paper (links)         | **5.57:1**  | 4.5    | pass   |
| Clay on `muted`               | **5.14:1**  | 4.5    | pass   |
| Sage on Paper                 | **5.14:1**  | 4.5    | pass   |
| Sage on `muted`               | **4.74:1**  | 4.5    | pass   |
| Stone on Paper (muted text)   | **5.40:1**  | 4.5    | pass   |
| Stone on `muted`              | **4.98:1**  | 4.5    | pass   |
| Paper on Clay (block)         | **5.57:1**  | 4.5    | pass   |
| Paper on Sage (block)         | **5.14:1**  | 4.5    | pass   |
| Paper on `destructive`        | **6.82:1**  | 4.5    | pass   |
| `input` border on Paper       | **3.28:1**  | 3.0    | pass   |
| `input` border on `muted`     | **3.03:1**  | 3.0    | pass   |

**Stone has now failed twice, for two different reasons, and both are recorded because the second
one was caught in review rather than by me.** It shipped first as `#7A7266` and measured 4.32:1 on
Paper — caught while writing this file. It then shipped as `#746C60`, which cleared Paper at 4.72:1
but measured **4.36:1 on the `muted` surface** — a real AA failure in the neutral `Badge` and the
CMS hero eyebrow, missed because the first round of tests only checked text against the page and
because Lighthouse audited only the PLP and PDP, where those components do not appear. It is now
`#6B6357`: 5.40:1 on Paper, 4.98:1 on `muted`. The lesson is in the test, not just in this
paragraph — the suite now walks the full surface matrix.

Nothing in the palette relies on colour alone to carry meaning: an out-of-stock mark is Stone text
that says so, not a grey dot.

---

## 3. Type — a self-hosted pairing

**Newsreader** for display, **Hanken Grotesk** for text and UI. Both SIL Open Font License 1.1.

- **Newsreader** (Production Type) is a genuine editorial text serif — it was drawn for reading,
  not for logos, so it stays calm at 40px where a display serif would shout. It carries headings,
  the product name on the PDP, and pull quotes.

  **The optical-size axis was dropped, and that was a real loss.** Newsreader ships `opsz` as well
  as `wght`; the two-axis Latin file measures **132 kB** against **58 kB** for weight alone. 74 kB,
  more than double, for a face that only sets headings — on a storefront where perf is a required
  check. Measured after the first download, not assumed. The optical grading is the better
  typography and the budget is the stronger claim, so the budget won.

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

- **Radius: none. Every step, including `full`.** `sm`, `md`, `lg`, `xl` and `full` all collapse to
  `2px`. Rounded corners read as software; a printed page has square corners and so does this one.

  An earlier draft kept `full` on the kit default "for the one case that genuinely needs a circle (an
  avatar)". Review asked why `Badge` was still a pill, and the answer was that the exemption was
  protecting nothing: `rounded-full` resolves to this token, its only user in `@platform/ui` is
  `Badge`, and **there is no avatar component in the kit or this app**. So the exemption rounded the
  one component it reached and guarded a case that does not exist. When brand A does need a circle,
  the right move is an `Avatar` in the kit whose shape does not ride on the shared radius scale.

- **Shadow: none.** All four shadow tokens become `none`. Separation is done with a 1px rule in
  `border` (a Paper tint, not Stone itself — an earlier draft of this file said "a 1px Stone rule",
  which the tokens never did: full Stone at 5.40:1 is a heavy line, and an editorial hairline wants
  to be quieter than its text) or with whitespace, never with a float. This is the single biggest
  lever against the generic look — it removes the card-floating-on-a-grid idiom in one move.

Depth in brand A is created by the amount of empty space around a thing, not by lifting it.

---

## 4b. Dark mode — a deliberate no, for brand A, in Phase 2

Issue #140 asks for a dark-mode _decision_. This is it, with the reasoning, so it can be overturned
on evidence rather than revisited from scratch.

**Brand A ships no dark mode.** Three reasons, in order of weight:

1. **It contradicts the brand's one material idea.** §1 commits to warm and paper-like: off-white
   stock, ink, a linen swatch. "Paper, inverted" is not a darker version of that idea, it is a
   different idea — a dark editorial apparel site is a legitimate design, but it is not _this_ design
   and pretending one palette can be both produces neither.
2. **A dark palette is a second full design, not a toggle.** Every ratio in §2 would have to be
   re-derived: Clay at 5.57:1 on Paper is unreadable on a dark ground, Stone inverts to something
   that is no longer "the colour of a caption", and the `border`/`input` split of §2 needs different
   values again. That is a real piece of design work with its own measurements, and doing it badly is
   worse than not doing it — a half-checked dark mode is where contrast failures hide, as Stone on
   `muted` just demonstrated in the light one.
3. **Nothing asks for it.** No acceptance criterion in Phase 2 needs it, no market requirement
   mentions it, and the kit gives a brand one token set rather than a light/dark pair — so honouring
   `prefers-color-scheme` would mean building the switching mechanism as well as the palette.

**What the page does instead.** Nothing clever. Brand A does not fight the operating system and does
not force a scheme with `color-scheme: only light`: it simply declares one palette, which a browser
in dark mode renders as-is. Users who need a dark screen are served by the OS and browser-level
inversion tools, which work better on a page that has one honest set of colours than on one that
second-guesses them.

**What would change this.** Any of: a market or accessibility requirement naming dark mode; the kit
gaining first-class light/dark token pairs (making this a palette job rather than a mechanism job);
or evidence from real traffic that a meaningful share of brand A's customers browse in dark mode and
bounce. The work then is a full second palette with its own §2 table and its own measured ratios —
budget it as design, not as a flag.

---

## 5. Mechanism — how the theme is applied

Everything in this design ships through `src/brand/**` and nothing else. The rest of `src/**` stays
byte-identical to `apps/storefront-starter`, so `pnpm --filter @platform/storefront-brand-a sync`
stays a reviewable diff (the 2.1 decision, ADR 0004).

| File                          | Carries                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| `src/brand/fonts.ts`          | The two `next/font/local` faces and their fallbacks.           |
| `src/brand/fonts/*.woff2`     | The font binaries and their OFL licence texts.                 |
| `src/brand/tokens.ts`         | Colour, font family, line height, radius and shadow overrides. |
| `src/brand/config.ts`         | Name, description and canonical origin for metadata (#254).    |
| `src/app/icon.svg`            | Favicon — Ink on Paper, square, no webfont dependency.         |
| `src/app/opengraph-image.tsx` | The default share card, in the brand palette.                  |

The last two sit outside `src/brand/` because Next resolves `icon` and `opengraph-image` by file
convention and will not look anywhere else. They are **new** files rather than edits to starter ones,
so a re-sync neither overwrites nor deletes them; both are listed in the README's diff table.

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

- Every text pair in §2 is measured above and clears WCAG AA; the body pair clears AAA. Lighthouse
  scores accessibility **1.00** on both the PLP and the PDP.
- `test/brand-theme.test.ts` recomputes every ratio in §2 from the tokens that actually ship, so a
  published number and the implementation cannot drift apart silently.
- `:focus-visible` keeps the starter's 2px ring, re-coloured to Ink so it is visible on Paper.
- `font-display: swap` on both faces, with a metric-compatible fallback so the swap does not reflow.
- **No `<link rel="preload">` is emitted for either face, and that is a deliberate accepted cost.**
  `next/font` emits a preload only when a font's `className` or `variable` is rendered onto an
  element. Wiring through `tokens.ts` (§5) means neither is — the family reaches the page as a
  string. The earlier draft of this file claimed both faces were preloaded; the build output says
  otherwise, and the measurement below is why the trade was kept rather than reversed:

  | Measured (Lighthouse, median of 3, production build) | PLP    | PDP    |
  | ---------------------------------------------------- | ------ | ------ |
  | Performance                                          | 0.96   | 0.96   |
  | Accessibility                                        | 1.00   | 1.00   |
  | SEO                                                  | 0.92   | 0.92   |
  | Cumulative layout shift                              | 0.0000 | 0.0001 |

  CLS is effectively zero because `next/font` generates a size-adjusted metric-compatible fallback
  (`'textSans Fallback'`) behind each face, so the swap replaces text of the same measure. Buying a
  preload back would mean rendering a font class from a slot, and the only always-present slots are
  `Header`/`Footer`, which checkout and account do not render — reintroducing exactly the hole §5
  exists to close, to fix a problem that measures at 0.0001.

- No token in this design adds a network request, an animation, or a blocking script.
- **axe runs over five pages, plus a contrast re-scan of the PDP** (`e2e/a11y.spec.ts`), against the full WCAG 2.1
  A/AA rule set, not contrast alone. This exists because Lighthouse's 1.00 audited only the PLP and
  PDP and missed a real AA failure in components that render on neither.
- **Visual baselines for home / PLP / PDP** (`e2e/visual.spec.ts`), keyed by platform and opt-in via
  `E2E_VISUAL=1`, so the look has to change on purpose.

---

## 7. Imagery

**Source and delivery.** 19 stills and 2 hero loops, generated for brand A and listed in
`cms/brand-a/media/manifest.json` with size, sha256, aspect and alt text. The binaries are never in
the repo: the owner uploads them to Cloudinary (`cms/brand-a/scripts/upload-media.mjs`), and pages
receive them through the shared Cloudinary loader, which picks width, format and quality per request.
Content refers to an image by **slot** (`"mediaSlot": "home-hero-01"`), and the slot becomes a
delivery URL at seed time. Until a cloud name exists, the seed leaves the images out, so brand A
renders text-only rather than broken.

**What the pictures look like, and why.** Undyed and natural cloth, worn wood, plaster walls, and low
warm daylight from one side. The colours sit inside §2's palette: Paper, Stone and Ink, with rust and
camel as the only warm accents. No filters, no overlays, no text set into an image. Text over a
photograph cannot be contrast-measured the way §2 measures everything else, so headlines sit beside
images, never on them.

**Proportions by placement.** The seed refuses a slot placed where its aspect does not fit
(`ALLOWED_ASPECTS` in `resolve-media.mjs`):

| Placement                | Aspect                                 | Used for                                       |
| ------------------------ | -------------------------------------- | ---------------------------------------------- |
| Hero                     | 3:2                                    | home, about, cloth, the autumn campaign        |
| Image block, full width  | 3:2                                    | home (the linen shirt), autumn campaign        |
| Image block, text column | 3:2 or 3:4                             | about (the loom), autumn campaign (the avenue) |
| Open Graph               | 16:9 (Cloudinary crops it to 1200×630) | the home page's share image                    |

Reserved, not yet placed: `home-hero-03` and the spring, summer and winter campaign sets. A slot
gets alt text in both locales when it is placed, and a test fails any placed slot without it.

**Alt text.** It says what is in the picture: the garment, the cloth, the setting. It never says
"image of", and never repeats the headline next to it. It is written in the manifest per locale
(en-GB and de-DE), at most 160 characters, and the seed copies it into each document. When an image
is purely decorative, the fix is not to place it, rather than to leave its alt text empty.

**The hero loops — motion is opt-in, and always stoppable.** `home-hero-shirt-loop-8s` and
`campaign-autumn-hero-loop-8s` are 8-second silent loops. Each has a still as its poster: `home-hero-02`
and `campaign-autumn-hero` respectively. The poster pairing is assumed from the slot names and still
has to be checked against the first frame.

- Under `prefers-reduced-motion: reduce` the loop is **not loaded at all**: the poster still is the
  hero. Pausing a video that has already downloaded is not enough.
- Otherwise it plays muted, inline and looped, without audio and without controls chrome, but with
  a visible **pause** button. An 8-second loop runs longer than WCAG 2.2.2's 5-second limit for
  automatic motion, so a pause control is required, not optional.
- The video is decorative (`aria-hidden`). The poster's alt text is what the hero says to a screen
  reader.
- The poster is the LCP element and loads with high priority. The video starts only after it, so
  the loop never costs the §6 LCP budget.

The loops are not on the site yet. The CMS hero has no video field, and adding one is window 6's
(schema) and window 3's (rendering): REQUEST #330.

**Product images are not here.** The 36-image product matrix and the detail shots belong to the
catalogue seed (`packages/db`). They reach brand A through the Store API like any other product
media.
