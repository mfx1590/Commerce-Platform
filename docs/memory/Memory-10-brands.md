# Memory 10 — Brand storefronts (A, B, C…)
Window: 10 · Key: `brands` · Branch prefix: `brands/` · Model: Sonnet
Last updated: 2026-09-09 · Contracts: contracts-v0.3 (Store API 0.3.0, Admin API 0.3.0, events 0.2.0, db 0.2.0; v0.4 = Admin API 0.4.0 lands within hours, Store API unchanged — merge main when the manager confirms the tag) · Branch: `brands/phase2` · Status: 2.1 in PR

## Identity (does not change)
Owned paths (write):
- `apps/storefronts/<brand>/**`
- `cms/<brand>/**`
Reads:
- packages/ui
- apps/storefront-starter (read only)
Never touches:
- the starter
- other brands

## Mission — Phase 2 (Commerce complete, brand 1 live)
Brand A real storefront from the starter: theme/layout from Figma, real CMS content, checkout polish, SEO, i18n, full Playwright e2e browse → buy → account. Wave C — starts when cms 2.2 and core 2.2 have merged.

## Done
- **#139 · 2.1 Clone the starter into apps/storefronts/brand-a** — commit: the `brands: 2.1 clone the starter into apps/storefronts/brand-a` commit on brands/phase2 (sha recorded in the follow-up memory commit). Clone via `apps/storefronts/brand-a/scripts/sync-from-starter.mjs` (110 starter files; excludes Dockerfile/README/CHANGELOG/CLAUDE.md; preserves identity files + `src/brand/**` on re-sync, `pnpm --filter @platform/storefront-brand-a sync`). Identity: port 3101, `SITE_URL`/`STORE_PUBLISHABLE_KEY` (`pk_brand-a_dev_00000000000000000000`) as `??=` runtime defaults in next.config.mjs, path-depth fixes in tsconfig/tailwind/playwright. Verified: build green, `/health` 200, PLP/PDP/de-DE 200 against the mock, 184 unit tests, root lint+typecheck+format green, `diff -rq` vs starter = exactly the README's documented list. REQUEST #197 filed to window 5 (Dockerfile + image manifest; the `check-image-manifests.sh` CI failure on this PR is the intended prompt).

## In progress
- 2.1 PR open, waiting for the manager's merge. Building 2.2 (#140 theme) locally meanwhile; do not push 2.2 until the 2.1 merge is confirmed.

## Next — Phase 2 (GitHub issues; acceptance criteria there are authoritative)
- [x] **#139 · 2.1** Clone the starter into apps/storefronts/brand-a (in PR)
- [ ] **#140 · 2.2** Theme and layout overrides from the brand design
- [ ] **#141 · 2.3** CMS content for brand A
- [ ] **#142 · 2.4** SEO and i18n for brand A
- [ ] **#143 · 2.5** End-to-end suite browse → buy → account for brand A
- [ ] **#144 · 2.6** Launch checklist for brand A

## Decisions made (with reasons)
- **Brand identity lives in `next.config.mjs` runtime defaults (`??=`), not src edits** (2.1): `next build/dev/start` all load the config before app code, the environment still wins, and `src/**` stays byte-identical to the starter (except `src/brand/**`) so `sync-from-starter.mjs` re-syncs produce reviewable diffs. `KEYCLOAK_CLIENT_ID` needed no override — the starter already defaults to `storefront-brand-a`.
- **The sync script is self-hosting and lives in the brand app** (`scripts/sync-from-starter.mjs`): the starter stays untouched (window 3's path), and Phase 3's "scripted re-sync" (ADR 0004) exists from day one — preserve list = the README's documented diff table.
- **No Dockerfile in the brand app**: `**/Dockerfile` is window 5's ownership row, so the clone excludes it; REQUEST #197 asks for the image.

## Blocked / waiting
- (none)

## Gotchas learned
- The clone sits one directory deeper than the starter: `tsconfig.json` `extends`, `tailwind.config.ts` ui-dist glob and `playwright.config.ts` webServer `cwd` each need one more `../` — a byte-identical copy fails `next build` with TS5083 on `tsconfig.base.json`.
- Backgrounded `&` children of a Bash call can outlive the call (a stray Prism held :4010 and made the next `pnpm mock` die with EADDRINUSE while probes returned 401 = actually up). Check the port before assuming the mock is down.
- Integration 1 (2026-09-08): real Keycloak staff tokens are the default on the core's Admin API; `CORE_DEV_TOKENS=1` keeps `Bearer dev:<subject>` working locally. The storefront can run against the core with `STORE_API_URL=http://localhost:9000` (+ `CORE_STORE_API_FALLBACK=1` + `CORE_STORE_API_FALLBACK_URL=http://localhost:4010` on the core so unimplemented Store routes still answer from Prism). The admin uses `ADMIN_API_URL`.

## How to run & test this package
- `pnpm --filter "@platform/storefront-brand-a^..." build` once per fresh worktree (ui/cms/contracts dists), then `pnpm --filter @platform/storefront-brand-a build|start|dev|test|typecheck|e2e`. Mock: `pnpm mock` (:4010). App on :3101; `/health`. Against the core: `STORE_API_URL=http://localhost:9000` (core with `CORE_STORE_API_FALLBACK=1` + `CORE_STORE_API_FALLBACK_URL=http://localhost:4010`).
- Re-sync after merging main: `pnpm --filter @platform/storefront-brand-a sync`, review the git diff.

## Later phases (do not start until Memory-main says so)
### Phase 3 — Multi-store & HQ
Brands B and C the same way, using the onboarding flow; document what still needed a developer.
- [ ] Brand B
- [ ] Brand C
- [ ] Onboarding gaps report
