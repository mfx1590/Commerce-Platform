# ADR 0004 — One Next.js storefront per brand, generated from a shared starter, sharing a UI kit

Status: accepted (Phase 0, 2026-09-04) · Owner: main window · Implemented by window 3 (`apps/storefront-starter`, `packages/ui`) and window 10 (`apps/storefronts/<brand>`)

## Context

Each brand needs its own domain, theme, layouts, content and campaign pages, and may diverge in features. A single
multi-tenant storefront that switches theme by hostname is cheaper at first but every brand-specific change becomes
a conditional in shared code, and one bad deploy takes every brand down.

## Decision

1. **One app per brand** in `apps/storefronts/<brand>/`, created by copying `apps/storefront-starter` (a script in
   Phase 2). Each is deployed separately (Vercel project per brand, decision 5) behind its own Cloudflare zone.
2. **Shared code lives in packages, not in the starter.** `packages/ui` (primitives, theme tokens contract),
   `packages/contracts` (typed Store API client types). The starter is a template, not a dependency: a brand app
   does not import from the starter after generation.
3. **Theme = tokens, not forks.** A brand overrides `defaultTokens` (colors, type scale, radius, spacing) and may
   replace whole page layouts or components by file. It never patches `packages/ui` internals; if a primitive is
   missing, window 3 adds it to the kit for everyone.
4. **Storefronts hold no business logic.** They call the Store API only (`X-Publishable-Key` per brand), render what
   it returns, and send the customer to hosted payment fields. Pricing, stock, tax and promotions are computed by the
   core.
5. **Content from the CMS, per brand.** Sanity dataset per brand (`store.content_space_id`); content routes and the
   CMS client live in agreed folders owned by window 6 (`(content)` route group, `src/lib/cms`).
6. **The starter carries the tests.** Playwright journeys (PLP → PDP → cart → checkout) run against the Prism mock in
   Phase 1 and against staging later; every brand app inherits them and must keep them green.

## Consequences

- Cross-brand changes (a new checkout step) are made once in the starter and the kit, then applied to each brand app
  by a scripted re-sync (Phase 3 tooling) or by the brand window; drift is visible in git.
- N Vercel projects, N Playwright runs; CI runs only affected apps via Turborepo.
- Brand onboarding (Phase 3) = create store row + domain + CMS dataset + PSP account + search index + copy starter
  + set tokens; the HQ flow scripts all of it.
- SEO, i18n, analytics SDKs are configured in the starter so every brand starts correct.

## Alternatives rejected

- **Single multi-tenant storefront**: hostname switching is fine for themes but not for divergent features; one
  deploy = all brands.
- **Shopify-style themes on one engine**: no per-brand code ownership; conflicts with the window model.
- **Monolithic Next.js with route groups per brand**: one bundle, one failure domain, ownership collisions in CI.
