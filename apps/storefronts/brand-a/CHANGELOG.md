# Changelog — @platform/storefront-brand-a

## 0.3.0 — 2026-09-28 · task 2.3 part 1 (#141)

- **Re-synced from the starter** (154 copied, 1 merged, 11 preserved, 4 excluded), carrying in
  **#273's open-redirect fixes** that this app had been missing — `src/lib/safe-path.ts`, the OIDC
  callback and middleware hardening, `src/lib/cms/safe-href.ts` — plus the referral routes, product
  reviews, and the CMS home slots (window 6's REQUEST #178) that 2.3's content will fill.
- **`package.json` is now MERGED rather than preserved** (`scripts/merge-package-json.mjs`).
  Preserve is all-or-nothing: it kept the brand's identity and also froze everything the starter
  added afterwards, which is how this app missed `perf` and `bundle-budget` for a whole task before
  2.2 found the gap by hand. Identity survives (name, version, the 3101 dev port, brand-only
  scripts and dependencies); scripts and dependency versions track the starter.
- `test/sync-merge.test.ts` (13 tests) asserts **both halves** — a starter script arrives, a
  dependency bump arrives, a new top-level field arrives; the brand name, version, dev port,
  brand-only script and brand-only dependency all survive — plus non-mutation, sorted dependency
  blocks, and byte-level idempotency against the real files, so a re-sync produces no diff.

## 0.2.1 — 2026-09-28 · task 2.2 review fixes (#140, PR #280)

Three defects from review, two of which were the code disagreeing with `src/brand/DESIGN.md`.

- **WCAG AA regression fixed.** Stone on the `muted` surface measured **4.36:1** — below AA and
  below the kit default it replaced — in the neutral `Badge` and the CMS hero eyebrow. Stone is now
  `#6B6357`: 5.40:1 on Paper, 4.98:1 on `muted`. Missed because the first tests only checked text
  against the page and Lighthouse audits only the PLP and PDP, where neither component renders.
  The suite now walks **every text token against every surface it can land on**.
- **`input` split from `border`.** A form-field edge identifies a UI component (WCAG 1.4.11, 3:1);
  a divider does not. They shared one value at 1.28:1, leaving every field edge in checkout
  effectively invisible. `input` is now `#8F8676` — 3.28:1 on Paper, 3.03:1 on `muted`.
- **DESIGN/tokens drift closed.** §2 claimed "five, named, and no sixth" while the tokens shipped
  nine hex literals. The document now owns the four derived values (`muted`, `border`, `input`,
  `destructive`) with each one's measured ratio, and a test fails if a colour token ships a hex the
  design does not name. §4 now names `xl`, and the false "a 1px Stone rule" claim is corrected.
- **`radius.full` collapsed to 2px.** Review asked why `Badge` was still a pill: `rounded-full`
  resolves to this token, its only user in `@platform/ui` is `Badge`, and **no avatar component
  exists** — so §4's "kept for avatars" exemption guarded nothing and rounded the one component it
  reached.
- **The display face now actually renders.** Newsreader was loaded but unused: nothing in the kit or
  the starter asks for `font-serif`, so 58 kB shipped to render nowhere while §3 described it
  carrying headings. `src/brand/theme.css` (one rule, element selectors) puts headings on it. Found
  by the new visual baseline — which is what that suite is for.
- **#140's own acceptance criteria**, which the first PR description replaced with its own list:
  - **axe in the e2e suite** — `e2e/a11y.spec.ts`, five pages plus a contrast re-scan of the PDP,
    full WCAG 2.1 A/AA, zero `color-contrast` violations. Local only for now: CI does not run the
    spec until window 2 lands #212's opt-in. Two rules are suppressed with a documented, issue-linked allowlist:
    `dlitem` + `definition-list`, one inherited starter defect (REQUEST #286).
  - **Visual regression snapshots for home/PLP/PDP** — `e2e/visual.spec.ts`, platform-keyed and
    opt-in via `E2E_VISUAL=1`. Tolerance tightened from 0.01 to 0.002 after 0.01 proved loose
    enough to sleep through the entire heading typeface changing.
  - **Dark-mode decision** — a documented no for brand A in Phase 2, with reasons and what would
    overturn it (DESIGN.md §4b).
  - **Favicon / OG defaults** — `src/app/icon.svg` and `src/app/opengraph-image.tsx`, in the brand
    palette rather than the kit's dark neutral, with tests pinning their colours to the tokens.
- README: the repro commands now include the two build steps and the `ROBOTS_ALLOW_INDEXING=1`
  requirement.

## 0.2.0 — 2026-09-25 · task 2.2 (#140)

- **Re-synced from the starter** ahead of the theme: 148 copied, 10 preserved, 4 excluded. Brings
  in storefront 2.2-2.4 (SEO/JSON-LD/sitemap/robots, CSP, perf + bundle budgets, the `(content)`
  campaign and legal routes, Cloudinary media) and **#254's `src/brand/config.ts`**.
- **Brand A's design**, authored in `src/brand/DESIGN.md` — no Figma exists, so the document is the
  design and is written before the code. Calm editorial D2C apparel; explicitly not the admin's
  dark Medusa rail and not the generic AI storefront.
- **Palette**: five named values — Paper `#F7F4EF`, Ink `#23201B`, Clay `#9C4A32`, Sage `#5F6B57`,
  Stone `#746C60`. Every pair measured against WCAG 2.1; Stone was darkened from `#7A7266` after it
  measured 4.32:1. Primary is Ink, not the accent.
- **Type**: Newsreader over Hanken Grotesk, self-hosted as Latin-subset woff2 under
  `src/brand/fonts/` (OFL 1.1, licences beside them) and loaded with `next/font/local` — the build
  stays hermetic and no page view reaches `fonts.gstatic.com`. Newsreader ships weight-only: the
  optical-size axis costs 74 kB on a face that only sets headings.
- **Shape**: radius collapses to 2px, all four shadow tokens to `none`.
- Fonts are wired through `tokens.ts`, not a component slot — the checkout and account layouts
  render no `Header`, so a slot-injected font would drop out at checkout. Verified in the build
  output and the served HTML, not assumed (DESIGN.md §5).
- `brandConfig` names the brand (**Fieldnote**) and its description, so the title template and
  Open Graph tags land in `<head>` without an API round trip (#254's mechanism).
- **New** `test/brand-theme.test.ts` (21 tests): recomputes every contrast ratio DESIGN.md
  publishes from the tokens that actually ship, asserts the shape/type tokens, and asserts the
  faces are loaded from local woff2 rather than a CDN. `next/font/local` is mocked — it is a
  build-time transform with no runtime implementation.
- Added the `perf` and `bundle-budget` scripts and pinned `@lhci/cli` to 0.14.0, matching the
  starter: `package.json` is on the PRESERVE list, so it had silently missed them.
- `test/slots.test.ts` temporarily deviates and is preserved on sync — the starter's copy asserts
  this brand's override files are empty, which is false by construction in a clone (REQUEST #278).
- Measured on a production build: performance 0.99 / 0.97 — **superseded, see 0.2.1**, which
  re-measured 0.96 / 0.96 after the review fixes — accessibility **1.00**, SEO 0.92,
  CLS 0.0000 / 0.0001 (PLP / PDP); bundle budget green on all seven routes.

## 0.1.0 — 2026-09-09 · task 2.1 (#139)

- Generated from `apps/storefront-starter` 0.8.1 (ADR 0004) via the new
  `scripts/sync-from-starter.mjs`: 110 tracked starter files copied; `Dockerfile` (window 5's
  path — REQUEST filed for the image), `README.md`, `CHANGELOG.md` and `CLAUDE.md` excluded.
- Brand A identity: package name, port **3101** (`dev` script, `start.mjs` default — `start`
  still honours `$PORT` for the image contract), `SITE_URL` and `STORE_PUBLISHABLE_KEY`
  (`pk_brand-a_dev_00000000000000000000`, the packages/db seed key) as runtime defaults in
  `next.config.mjs`, Playwright/Lighthouse URLs on :3101. `KEYCLOAK_CLIENT_ID` keeps the
  starter's `storefront-brand-a` default. `/health` inherited.
- The complete diff-against-starter list lives in the README and is enforced by the sync
  script's preserve/exclude sets.
