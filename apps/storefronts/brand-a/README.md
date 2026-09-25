# @platform/storefront-brand-a

Brand A's storefront — EU market, EUR, locales `en-GB` and `de-DE` (docs/decisions.md #2).
Generated from `apps/storefront-starter` per ADR 0004: the starter is a template, not a
dependency, and this app never imports from it. Owner: window 10 (brands).

For everything the app _does_ — the Store API client, routes, cart/checkout, locales, accounts,
attribution, the brand override pattern — read the starter's README: this app is that app, plus
the identity below. Documenting behaviour twice would only let the copies drift.

## Run it

```bash
pnpm mock                                          # Prism Store API on :4010
pnpm --filter @platform/storefront-brand-a dev     # brand A on :3101
```

Against the real core instead of the mock: start the core on :9000 with
`CORE_STORE_API_FALLBACK=1` and `CORE_STORE_API_FALLBACK_URL=http://localhost:4010` (customers
routes still answer from Prism), then run this app with `STORE_API_URL=http://localhost:9000`.
Known gap until window 3's #109 lands: `next/image` rejects the seed's picsum thumbnails, so the
PLP renders without images against the core.

Brand A defaults (each overridable in the environment):

| Variable                | Brand A default                       | Set in                                    |
| ----------------------- | ------------------------------------- | ----------------------------------------- |
| `PORT`                  | `3101`                                | `scripts/start.mjs` (dev: `package.json`) |
| `SITE_URL`              | `http://localhost:3101`               | `next.config.mjs`                         |
| `STORE_PUBLISHABLE_KEY` | `pk_brand-a_dev_00000000000000000000` | `next.config.mjs`                         |
| `KEYCLOAK_CLIENT_ID`    | `storefront-brand-a`                  | starter default (no change)               |

The publishable key is brand A's seeded dev key (`SEED_IDS.publishableKeys.brandA` in
`packages/db`; hashed in the database, public by design). The Store API resolves store `brand-a`
and its sales channel from it. `GET /health` answers 200 for the container HEALTHCHECK.

## Diff against the starter (the complete list)

Everything else is byte-identical to `apps/storefront-starter` at the commit of the last sync.

| File                                     | Why                                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `package.json`                           | name `@platform/storefront-brand-a`, version, dev port 3101, `sync` script                    |
| `test/slots.test.ts`                     | **temporary** — drops assertions that this brand overrides nothing (REQUEST #278)             |
| `scripts/start.mjs`                      | default port 3101                                                                             |
| `next.config.mjs`                        | brand env defaults (`SITE_URL`, `STORE_PUBLISHABLE_KEY`) via `??=`                            |
| `playwright.config.ts`                   | `APP_URL` default :3101; mock webServer `cwd` one level deeper                                |
| `lighthouserc.json`                      | audit URLs on :3101                                                                           |
| `tsconfig.json`                          | `extends` path one level deeper (`../../../tsconfig.base.json`)                               |
| `tailwind.config.ts`                     | kit-dist content glob one level deeper                                                        |
| `scripts/sync-from-starter.mjs`          | new — the clone/re-sync script                                                                |
| `README.md`, `CHANGELOG.md`, `CLAUDE.md` | this app's own docs (not copied)                                                              |
| `Dockerfile`                             | **absent** — every Dockerfile is window 5's path; the brand image arrives via a REQUEST issue |
| `src/brand/**`                           | the brand's design: `DESIGN.md`, `tokens.ts`, `fonts.ts`, `fonts/*.woff2`, `config.ts` (2.2)  |

## Theme

Brand A's design is authored in **[`src/brand/DESIGN.md`](src/brand/DESIGN.md)** — there is no
Figma, so that file is the design and the code is held to it. Change it there first.

In short: calm editorial D2C apparel. Five named colours (Paper `#F7F4EF`, Ink `#23201B`, Clay
`#9C4A32`, Sage `#5F6B57`, Stone `#746C60`), every pair measured against WCAG and re-measured in
`test/brand-theme.test.ts`. Newsreader over Hanken Grotesk, self-hosted as woff2 under
`src/brand/fonts/` and loaded with `next/font/local` so no build and no page view touches
`fonts.gstatic.com`. Square corners, no shadows.

The theme ships entirely through tokens — brand A overrides no component or layout slot. The fonts
are wired through `tokens.ts` rather than a slot because the checkout and account layouts render no
`Header`, and a font injected from a slot would drop out there; see DESIGN.md §5.

Measured on a production build (Lighthouse, median of 3): performance 0.99 / 0.97, accessibility
**1.00**, SEO 0.92, CLS 0.0000 / 0.0001 (PLP / PDP). `/robots.txt` fails closed — the SEO audit
needs `ROBOTS_ALLOW_INDEXING=1` to score, or it reads `Disallow: /` and lands around 0.58.

## Re-syncing from the starter

When the starter gains a fix (take it by merging main — never the storefront window's branch):

```bash
pnpm --filter @platform/storefront-brand-a sync
```

`scripts/sync-from-starter.mjs` copies the starter's tracked files over this app, skipping the
excluded files and never overwriting the identity files or `src/brand/**` (the table above).
Review the resulting git diff — that is the drift, by construction.

Two things the PRESERVE list costs, worth checking after any sync:

- **`package.json` never takes new starter scripts.** The starter added `perf` and `bundle-budget`
  in its 2.3; this app only got them because 2.2 noticed and copied them across by hand.
- **`test/slots.test.ts` is preserved while REQUEST #278 is open.** Drop it from `PRESERVE`,
  re-sync, and delete the deviation comment once window 3 has moved the starter-only assertions
  out of the shared test.

## Test

```bash
pnpm --filter @platform/storefront-brand-a test        # Vitest (inherited from the starter)
pnpm --filter @platform/storefront-brand-a typecheck
pnpm --filter @platform/storefront-brand-a e2e         # Playwright; boots the mock + a prod build on :3101
```

The account e2e journeys need Keycloak (`pnpm compose:up`); they skip locally without it and are
required on CI. Lighthouse: build, start, then
`pnpm --filter @platform/storefront-brand-a lighthouse` (budgets: perf/a11y ≥ 90, LCP ≤ 2.5 s,
CLS ≤ 0.1).
