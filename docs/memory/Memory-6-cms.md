# Memory 6 — CMS & landing pages

Window: 6 · Key: `cms` · Branch prefix: `cms/` · Model: Sonnet
Last updated: 2026-09-04 · Contracts: (not tagged yet) · Last commit: (none) · Status: not started

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

Headless CMS with one workspace per brand: schemas (page, hero, blocks, campaign landing, nav, footer, legal, product-story block), fetch layer with preview + revalidate-on-publish, content routes, Builder.io/Framer embed under /campaign/*, media via Cloudinary. cms/README explains how a marketer builds a landing page alone.

## Done

- (nothing yet)

## In progress

- (nothing yet)

## Next — Phase 2

- [ ] CMS schemas
- [ ] Fetch layer + preview mode + publish webhook revalidation
- [ ] Content routes in starter
- [ ] Campaign embed pattern
- [ ] Cloudinary pipeline
- [ ] Marketer guide

## Decisions made (with reasons)

- (none yet)

## Blocked / waiting

- (none)

## Gotchas learned

- (none yet)

## How to run & test this package

- (fill in after first setup: exact commands)
