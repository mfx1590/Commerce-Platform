# Memory 6 — CMS & landing pages
Window: 6 · Key: `cms` · Branch prefix: `cms/` · Model: Sonnet
Last updated: 2026-09-08 · Contracts: contracts-v0.3 (Store API 0.3.0, Admin API 0.3.0, events 0.2.0, db 0.2.0; tagged at the end of Integration 1) · Branch: `cms/phase2` · Status: not started (Phase 2)

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
- (nothing yet)

## In progress
- (nothing — Phase 2 starts with the first item under Next)

## Next — Phase 2 (GitHub issues; acceptance criteria there are authoritative)
- [ ] **#119 · 2.1** Sanity workspace and schemas per brand
- [ ] **#120 · 2.2** Fetch layer, preview mode, revalidate-on-publish
- [ ] **#121 · 2.3** Content routes in the starter and (content) localisation
- [ ] **#122 · 2.4** Campaign landing pattern under /campaign/*
- [ ] **#123 · 2.5** Cloudinary media for CMS content

## Decisions made (with reasons)
- (none yet)

## Blocked / waiting
- (none)

## Gotchas learned
- Integration 1 (2026-09-08): real Keycloak staff tokens are the default on the core's Admin API; `CORE_DEV_TOKENS=1` keeps `Bearer dev:<subject>` working locally. The storefront can run against the core with `STORE_API_URL=http://localhost:9000` (+ `CORE_STORE_API_FALLBACK=1` + `CORE_STORE_API_FALLBACK_URL=http://localhost:4010` on the core so unimplemented Store routes still answer from Prism). The admin uses `ADMIN_API_URL`.

## How to run & test this package
- (fill in after first setup: exact commands)
