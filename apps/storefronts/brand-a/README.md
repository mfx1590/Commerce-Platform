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
| `scripts/start.mjs`                      | default port 3101                                                                             |
| `next.config.mjs`                        | brand env defaults (`SITE_URL`, `STORE_PUBLISHABLE_KEY`) via `??=`                            |
| `playwright.config.ts`                   | `APP_URL` default :3101; mock webServer `cwd` one level deeper                                |
| `lighthouserc.json`                      | audit URLs on :3101                                                                           |
| `tsconfig.json`                          | `extends` path one level deeper (`../../../tsconfig.base.json`)                               |
| `tailwind.config.ts`                     | kit-dist content glob one level deeper                                                        |
| `scripts/sync-from-starter.mjs`          | new — the clone/re-sync script                                                                |
| `README.md`, `CHANGELOG.md`, `CLAUDE.md` | this app's own docs (not copied)                                                              |
| `Dockerfile`                             | **absent** — every Dockerfile is window 5's path; the brand image arrives via a REQUEST issue |
| `src/brand/**`                           | the brand's tokens/slots — starter's versions until task 2.2 (#140)                           |

## Re-syncing from the starter

When the starter gains a fix (take it by merging main — never the storefront window's branch):

```bash
pnpm --filter @platform/storefront-brand-a sync
```

`scripts/sync-from-starter.mjs` copies the starter's tracked files over this app, skipping the
excluded files and never overwriting the identity files or `src/brand/**` (the table above).
Review the resulting git diff — that is the drift, by construction.

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
