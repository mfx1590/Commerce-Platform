# Memory 17 — Marketing
Window: 17 · Key: `marketing` · Branch prefix: `marketing/` · Model: Opus
Last updated: 2026-09-05 · Contracts: contracts-v0.3 (created at Integration 1; do not start before it exists) · Last commit: (none) · Status: not started

## Identity (does not change)
Owned paths (write):
- `apps/core/src/modules/marketing/**`
- `apps/feeds/**`
- `apps/admin/src/app/(store)/[storeId]/marketing/**`
- `apps/admin/src/app/(hq)/marketing/**`
Reads:
- docs/marketing-scope.md (the scope and decisions)
- packages/contracts (Admin API marketing paths, v0.3)
- packages/events (campaign.*, feed.published, attribution.recorded, referral.converted, review.published, cart.abandoned)
- apps/core/src/modules/{registry,catalog}/index.ts (public APIs only), promotions module public API (window 9)
Never touches:
- packages/*, docs/ (except this file), other modules' internals, messaging delivery (window 16), CMS (window 6)

## Mission — Phase 2 (Commerce complete, brand 1 live)
Make marketing a product, not a side effect: campaigns with server-side attribution, product feeds for Google Merchant and Meta per brand, segments with a rule builder synced to the messaging provider, abandoned-cart recovery, and the Marketing section of the admin (Store view). Every number reported comes from events and orders in the core, never from a pixel.

## Done
- (nothing yet)

## In progress
- (nothing yet)

## Next — Phase 2 (issues are created by the manager at Integration 1)
- [ ] 2.1 Campaign module: CRUD, launch/end (events), attribution report (revenue by source/medium/campaign, first vs last touch) from `attribution` rows written at order placement
- [ ] 2.2 Product feeds: Google Merchant + Meta catalog per store/locale/currency; mapping from catalog + prices + availability; publish job; feed URL served by `apps/feeds`; errors surfaced
- [ ] 2.3 Segments: rule model (orders, spend, recency, tags, consent, country), preview count, materialise job, sync contract to Klaviyo through window 16's public API
- [ ] 2.4 Abandoned-cart recovery: consume `cart.abandoned` (emitted by window 1), recovery link with attribution, recovery-rate report; message sending stays in window 16
- [ ] 2.5 Admin Marketing section v1: Overview, Campaigns, Segments, Feeds screens against the Admin API; permissions per docs/marketing-scope.md
- [ ] 2.6 Module READMEs, CLAUDE.md, tests green; memory updated

## Decisions made (with reasons)
- 2026-09-05 (manager) · Campaigns/feeds/reviews/referrals are store-level; segment templates and the dashboard are organization-level — same tenancy model as the core.
- 2026-09-05 (manager) · Attribution is server-side from UTM/referrer captured on the cart (window 3 does the capture in Phase 1); pixels are optional extras, never the source of reported numbers.
- 2026-09-05 (manager) · Marketing never mutates orders, prices or stock; it reads events and writes its own tables.

## Blocked / waiting
- Waiting for Integration 1: tables (campaign, segment, segment_member, product_feed, attribution, referral_program, referral, review), events, Admin API `/admin/stores/{storeId}/marketing/**` in contracts-v0.3.

## Gotchas learned
- (none yet)

## How to run & test this package
- (fill in after first setup: exact commands)

## Later phases (do not start until Memory-main says so)
### Phase 3 — Multi-store & HQ
- [ ] Referral programme (codes, landing `/r/{code}` with window 3, rewards via promotions, `referral.converted`)
- [ ] Reviews: submission after `shipment.delivered` (request e-mail via window 16), moderation queue, PDP display contract with window 3
- [ ] Consent centre: per-channel opt-in rates, double opt-in for EU brands, export for audits
- [ ] HQ marketing dashboard: per-brand comparison, shared segment templates, budgets per legal entity (feeds window 15 a spend line)
### Phase 5 — Data platform & AI
- [ ] Loyalty (Talon.One or in-house) on top of segments + referral
- [ ] Marketing marts with window 12: campaign ROI, cohort LTV, channel mix
- [ ] AI: product copy for feeds and campaigns, segment suggestions (Claude API)
