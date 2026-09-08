# Memory 6 — CMS & landing pages
Window: 6 · Key: `cms` · Branch prefix: `cms/` · Model: Sonnet
Last updated: 2026-09-08 · Contracts: contracts-v0.3 = 583b407 (Store API 0.3.0, Admin API 0.3.0, events 0.2.0, db 0.2.0) · Branch: `cms/phase2` · Status: 2.1 in PR, 2.2 next

## Identity (does not change)
Owned paths (write):
- `cms/**`
- `apps/storefront-starter/src/app/(content)/**`
- `apps/storefront-starter/src/lib/cms/**`
Reads:
- packages/contracts
Never touches:
- apps/core
- rest of storefront starter

## Mission — Phase 2 (Commerce complete, brand 1 live)
Headless CMS with one workspace per brand: schemas (page, hero, blocks, campaign landing, nav, footer, legal, product-story block), fetch layer with preview + revalidate-on-publish, content routes, Builder.io/Framer embed under /campaign/*, media via Cloudinary. cms/README explains how a marketer builds a landing page alone. Wave A — starts right after contracts-v0.3 is tagged; nothing to wait for.

## Done
- **#119 · 2.1 Sanity workspace and schemas per brand** — 2026-09-08, commit: see PR (cms/phase2, first PR of Phase 2). `@platform/cms` 0.1.0: Studio config (one workspace per brand dataset), 10 object + 5 document schemas, `define.ts` structural mirror, `validateDocument`, fixtures, `datasets.ts`, seed script + manual steps, README, CHANGELOG. 35 tests (incl. compiling the registry with Sanity's own `createSchema`). Root config came from REQUEST #158 (main 94f1de3).

## In progress
- (nothing — 2.2 starts when the 2.1 PR is opened; keep building locally while it is in review)

## Next — Phase 2 (GitHub issues; acceptance criteria there are authoritative)
- [x] **#119 · 2.1** Sanity workspace and schemas per brand (PR open)
- [ ] **#120 · 2.2** Fetch layer, preview mode, revalidate-on-publish — `apps/storefront-starter/src/lib/cms/`: GROQ client per dataset (`datasetForStore(store.code)`), signed preview cookie, `revalidateTag` webhook verified by `SANITY_WEBHOOK_SECRET`, tags per document type, empty results + one warning without credentials. Storefront gets `@platform/cms` as a workspace dep (types, `SANITY_API_VERSION`, fixtures for tests). Unblocks windows 10 and 3 — open early.
- [ ] **#121 · 2.3** Content routes in the starter and (content) localisation
- [ ] **#122 · 2.4** Campaign landing pattern under /campaign/*
- [ ] **#123 · 2.5** Cloudinary media for CMS content

## Decisions made (with reasons)
- **One document per BCP-47 locale, `(type, locale, slug)` unique** (accepted by the manager 2026-09-08). The storefront routes `/[locale]/…` with next-intl and renders one language per request; a document per locale maps 1:1 onto that URL, GROQ filters `locale == $locale`, a missing translation is a missing document (not a half-translated page), and it mirrors `store_locale` (row per locale). Field-level i18n would fight the route tree. Uniqueness is a Studio-side query (`uniqueLocaleSlug`); ids are deterministic `<type>.<locale>.<slug>` (`documentId`) so seeds re-run and a translation is the same id with another locale. Window 10 adds de-DE by cloning fixtures (README "Adding a locale").
- **`sanity` is a devDependency for the Studio only; `src/**` types schemas against a local structural mirror (`src/schema/define.ts`).** The storefront imports the built `dist/` and must not pull the Studio; CI neither. `sanity.config.ts` casts `schemaTypes` to Sanity's union (the mirror is structural, not discriminated) and `test/sanity-compile.test.ts` compiles the registry with Sanity's own `createSchema` — proven non-vacuous (a bogus type yields `error: Unknown type`).
- **Validation is data the tests can run.** `RecordingRule` (immutable like Sanity's Rule) records the chain; `validateDocument` walks fields/named types/arrays. Sanity enforces validation only in the Studio, so this is what the seed, fixtures and later the fetch-layer tests rely on.
- **Datasets = `store.code` = `store.content_space_id`** (`brand-a|b|c`), environments are further datasets (`brand-a-staging` when needed). Private datasets; the storefront reads server-side only.
- **Links are storefront paths or http(s) only** (`uri({allowRelative, scheme})`): `javascript:`/`mailto:` rejected at the schema. Product stories carry a kebab-case handle, never a price (ADR 0004).
- **Seed via Sanity's HTTP API from a `.mjs` runner over the built `dist/`** (no `@sanity/client` dep, no tsx): uploads a 1×1 PNG placeholder and rewrites fixture asset refs, because Sanity rejects strong references to missing assets. Without credentials prints manual steps, exits 0, writes nothing.

## Blocked / waiting
- (none)

## Gotchas learned
- Integration 1 (2026-09-08): real Keycloak staff tokens are the default on the core's Admin API; `CORE_DEV_TOKENS=1` keeps `Bearer dev:<subject>` working locally. The storefront can run against the core with `STORE_API_URL=http://localhost:9000` (+ `CORE_STORE_API_FALLBACK=1` + `CORE_STORE_API_FALLBACK_URL=http://localhost:4010` on the core so unimplemented Store routes still answer from Prism). The admin uses `ADMIN_API_URL`.

- `sanity schema validate` (CLI) cannot load our config: its esbuild-register loader does not map NodeNext `.js` specifiers to `.ts`. The Studio itself (`sanity dev`, Vite) does. Hence the compile test instead of a CLI script.
- Sanity's CLI only passes `SANITY_STUDIO_*` env vars to the config; `scripts/studio.mjs` maps `SANITY_PROJECT_ID` from the root `.env` onto `SANITY_STUDIO_PROJECT_ID`.
- Bash tool: a `cd` inside one call persists into later calls (and into background jobs started afterwards) — always `cd /c/Users/mehdi/Desktop/wt-cms &&` or use absolute paths.
- `exactOptionalPropertyTypes`: `{ ...obj, validation: undefined }` is a type error; destructure the key away instead.

## How to run & test this package
- `pnpm --filter @platform/cms typecheck` (src + tests, then `tsconfig.studio.json` with `sanity.config.ts`), `pnpm --filter @platform/cms test` (Vitest, 35 tests), `pnpm --filter @platform/cms build` (dist for the storefront), `pnpm lint`, `pnpm format:check` (cms/** is prettier-checked; run `pnpm exec prettier --write cms`).
- Studio: `pnpm --filter @platform/cms studio` (needs `SANITY_PROJECT_ID` in `.env`); seed: `pnpm --filter @platform/cms seed -- --dataset brand-a|all` (needs `SANITY_WRITE_TOKEN`; prints manual steps otherwise).
