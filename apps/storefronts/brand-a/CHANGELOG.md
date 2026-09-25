# Changelog — @platform/storefront-brand-a

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
- Measured on a production build: performance 0.99 / 0.97, accessibility **1.00**, SEO 0.92,
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
