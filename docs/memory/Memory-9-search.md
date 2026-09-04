# Memory 9 — Search, media, promotions

Window: 9 · Key: `search` · Branch prefix: `search/` · Model: Sonnet
Last updated: 2026-09-04 · Contracts: (not tagged yet) · Last commit: (none) · Status: not started

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

Algolia index per brand synced from product.published events, merchandising rules API, Cloudinary media pipeline, price lists and coupon rules with stacking/exclusion tests.

## Done

- (nothing yet)

## In progress

- (nothing yet)

## Next — Phase 2

- [ ] Index schema per brand + full/incremental sync jobs
- [ ] Merchandising rules API
- [ ] Price lists
- [ ] Coupons + rule engine tests

## Decisions made (with reasons)

- (none yet)

## Blocked / waiting

- (none)

## Gotchas learned

- (none yet)

## How to run & test this package

- (fill in after first setup: exact commands)
