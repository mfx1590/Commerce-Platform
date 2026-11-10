# Brand A's faces — provenance and how to regenerate them

**The `.woff2` files in this directory are generated. Do not edit them, and do not replace them by
hand.** `test/brand-fonts.test.ts` rebuilds them and compares hashes, so a hand-placed binary fails
review rather than shipping.

```bash
node scripts/build-fonts.mjs            # regenerate the shipped faces
node scripts/build-fonts.mjs --check    # what the test runs
node scripts/build-fonts.mjs --charset  # print the derived charset
```

## What ships, and what it came from

| Shipped                      | Size    | From                                         | Size    | How                                           |
| ---------------------------- | ------- | -------------------------------------------- | ------- | --------------------------------------------- |
| `newsreader-latin.woff2`     | 21.1 kB | `source/newsreader-variable-latin.woff2`     | 56.7 kB | `wght` pinned to **500**, charset subset      |
| `hanken-grotesk-latin.woff2` | 19.6 kB | `source/hanken-grotesk-variable-latin.woff2` | 33.9 kB | `wght` trimmed to **400–700**, charset subset |

**40.8 kB shipped against 90.6 kB of sources — 49.8 kB off the critical path.**

| sha256 (first 16)  | File                                         |
| ------------------ | -------------------------------------------- |
| `62981321d9a3cc7a` | `source/newsreader-variable-latin.woff2`     |
| `e9201eddf1d41d0b` | `source/hanken-grotesk-variable-latin.woff2` |
| `285a7f2d2c552a13` | `newsreader-latin.woff2` (generated)         |
| `c7dd6377c17bbdd1` | `hanken-grotesk-latin.woff2` (generated)     |

Generated with **`subset-font@2.9.0`** (BSD-3-Clause, harfbuzz via WebAssembly — no native build, no
install scripts), a brand A devDependency pinned to an exact version so the output is reproducible.

## Licences

Both faces are **SIL Open Font License 1.1**. The licence texts travel with the sources:
`source/OFL-newsreader.txt`, `source/OFL-hanken-grotesk.txt`. The OFL permits subsetting and
instancing; the derived files remain under it, and neither face is renamed (the OFL's Reserved Font
Name clause is not engaged — nothing here declares a Reserved Font Name).

## Why these two trades and not others (#739)

Brand A's LCP sat on its 2500 ms budget: three of five CI runs were 2711–2719 ms, passing only
because the gate asserts the best of five. The cause, measured rather than guessed:

- The LCP element is **text** — the same synced `<h1>` markup as brands B and C — and its LCP phase
  table reads **Load Delay 0%, Load Time 0%**. No resource load gates it.
- Brand A loaded **exactly two things** B and C did not: these faces, **90.6 kB**. That was the whole
  request difference, 23 requests / 262 kB against 21 / 171 kB.
- `90.6 kB × 8 / 1600 kbps` (Lighthouse mobile throttling) = **453 ms**, against an observed
  render-delay difference of **444 ms**. Detaching the faces locally confirmed it a third time.

So the cost was **bytes contending for simulated bandwidth**, not the `font-display: swap` repaint —
which is why `display: 'optional'` was rejected: it removes no bytes, and it would have broken
`e2e/visual.spec.ts`, which deliberately awaits `document.fonts.ready`.

**The serif's weight axis.** Pinned to 500: −63%. DESIGN.md §3 already walked one step down this
ladder when it dropped the `opsz` axis (132 → 58 kB).

**This changed how headings look, and the first version of this file said it did not.** The claim
was that `theme.css` already set `h1–h4` at medium so nothing rendered heavier. That misread the
cascade: `theme.css` is an **element** rule and Tailwind's `.font-bold` is a **class**, which
outranks it. The 33 synced headings carrying `font-bold`/`font-semibold` — the LCP `<h1>` among them
— were rendering real **700** and **600**. Measured in a browser on the PDP: with brand A's
enforcement rule the `h1` computes to `500`; with that one rule deleted at runtime it computes to
`700`.

The pin is kept and the design is now **enforced** rather than aspirational, which is what
`theme.css` and DESIGN.md §3 always said the brand wanted — "at heading sizes it wants its lighter
weights, not bold". `theme.css` wins the specificity fight (`h1[class]`, (0,1,1), beats a utility's
(0,1,0) without `!important`) and sets `font-synthesis-weight: none` so a 500-only face is never
smeared into a fake bold. **Headings are lighter than they were on main. That is the intended
design, arrived at by accident-correction rather than by choice of this PR.**

**The sans's unused light range.** `packages/ui` defines normal 400, medium 500, semibold 600 and
bold 700, and the starter renders all four — `font-medium` ×36, `font-bold` ×19, `font-semibold` ×18,
`font-normal` ×1. **Nothing anywhere asks for 300**, so 300–400 was dead weight. Trimmed: −42%. The
axis is kept rather than replaced by static instances, which would trade bytes for extra requests.

**What was refused.** The pairing itself. A serif voice over a neutral ground is what brand A is
(DESIGN.md §1, §3); dropping a face would have cleared the budget outright and is not for sale
against a perf margin.

## The charset is derived, and the derivation found two things a list would not

`--charset` scans brand A's catalogues and committed CMS content, then asks `Intl` what the brand's
own locales and seeded currency actually emit. Both halves mattered:

- The scan found **U+201E DOUBLE LOW-9 QUOTATION MARK** — `de-DE` opens a quotation with it. A
  hand-written "latin plus umlauts" list misses it.
- `Intl` found **U+20AC EURO SIGN**, which appears in **no committed string at all**: prices are
  formatted at runtime from Store API numbers. Subsetting on the catalogues alone would have put a
  tofu box on every price on every product page.

**Printable Latin-1 is kept as the floor and is not negotiable for a few kB.** Product names,
category names and CMS prose arrive at runtime. A face carrying only today's 92 observed characters
renders a missing glyph the first time a product is called "Café" — and dropping the floor was
measured at 40.8 → 26.1 kB, about 45 ms once the sub-linear byte-to-time ratio is applied. Not a
trade worth a visible defect.

## What this did not fix

The worst run is still over budget: **2539 ms (PLP) and 2582 ms (PDP)** against 2500, improved from
2674 and 2752. With the faces removed entirely the worst run is **2163 / 2233**, so brand A sits
within ~300 ms of its budget before it loads a single brand byte. The remainder is the shared `h1`
render delay (~1.4 s in CI for every brand) and is tracked starter-side, not here.
