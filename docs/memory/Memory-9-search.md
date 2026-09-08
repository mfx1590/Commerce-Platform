# Memory 9 — Search, media, promotions
Window: 9 · Key: `search` · Branch prefix: `search/` · Model: Sonnet
Last updated: 2026-09-08 · Contracts: contracts-v0.3 (Store API 0.3.0, Admin API 0.3.0, events 0.2.0, db 0.2.0; tagged at the end of Integration 1) · Branch: `search/phase2` · Status: not started (Phase 2)

## Identity (does not change)
Owned paths (write):
- `apps/core/src/modules/search/**`
- `apps/core/src/modules/promotions/**`
- `apps/core/src/jobs/index-*.ts`
Reads:
- packages/events
Never touches:
- other core modules

## Mission — Phase 2 (Commerce complete, brand 1 live)
Algolia index per brand synced from product.published events, merchandising rules API, Cloudinary media pipeline, price lists and coupon rules with stacking/exclusion tests. Wave A — starts right after contracts-v0.3 is tagged; nothing to wait for.

## Done
- (nothing yet)

## In progress
- (nothing — Phase 2 starts with the first item under Next)

## Next — Phase 2 (GitHub issues; acceptance criteria there are authoritative)
- [ ] **#134 · 2.1** Algolia index per brand with full and incremental sync
- [ ] **#135 · 2.2** Merchandising rules API
- [ ] **#136 · 2.3** Cloudinary media pipeline for product media
- [ ] **#137 · 2.4** Price lists
- [ ] **#138 · 2.5** Promotions and coupon rule engine

## Decisions made (with reasons)
- (none yet)

## Blocked / waiting
- (none)

## Gotchas learned
- Integration 1 (2026-09-08): real Keycloak staff tokens are the default on the core's Admin API; `CORE_DEV_TOKENS=1` keeps `Bearer dev:<subject>` working locally. The storefront can run against the core with `STORE_API_URL=http://localhost:9000` (+ `CORE_STORE_API_FALLBACK_URL=http://localhost:4010` on the core so unimplemented Store routes still answer from Prism). The admin uses `ADMIN_API_URL`.

## How to run & test this package
- (fill in after first setup: exact commands)
