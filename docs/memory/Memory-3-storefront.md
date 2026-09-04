# Memory 3 — Storefront starter & UI kit

Window: 3 · Key: `storefront` · Branch prefix: `storefront/` · Model: Sonnet
Last updated: 2026-09-04 · Contracts: (not tagged yet) · Last commit: (none) · Status: not started

## Identity (does not change)

Owned paths (write):

- `apps/storefront-starter/**`
- `packages/ui/**`
  Reads:
- packages/contracts (mock API)
- design tokens export
  Never touches:
- apps/core
- apps/admin
- cms/ schemas

## Mission — Phase 1 (Isolated modules)

Next.js App Router storefront template and shared UI kit with a brand override mechanism (tokens, layout slots, component overrides). Pages: home, PLP, PDP, search, cart, checkout steps, account, order history, content pages. All data from the mock Store API. i18n + multi-currency from day one. Lighthouse ≥ 90 on PLP/PDP. Playwright smoke tests.

## Done

- (nothing yet)

## In progress

- (nothing yet)

## Next — Phase 1

- [ ] packages/ui: tokens, primitives (button, input, card, dialog, price, badge), theme provider
- [ ] Starter app skeleton, routing, layouts, brand override folder pattern
- [ ] PLP + PDP against mock API, images via next/image
- [ ] Cart + checkout steps (address, shipping, payment placeholder, review)
- [ ] Account + order history
- [ ] i18n (next-intl) + currency formatting
- [ ] Playwright smoke suite; Lighthouse CI config

## Decisions made (with reasons)

- (none yet)

## Blocked / waiting

- (none)

## Gotchas learned

- (none yet)

## How to run & test this package

- (fill in after first setup: exact commands)

## Later phases (do not start until Memory-main says so)

### Phase 2 — Commerce complete, brand 1 live

Storefront polish for real API, SEO, structured data, sitemap, performance budget.

- [ ] Real Store API wiring
- [ ] SEO/metadata/sitemaps
- [ ] Perf budget in CI
