# Marketing domain — scope and plan (added 2026-09-05 by the manager)

Marketing is a first-class domain with one owner: **window 17 (marketing)**. It orchestrates the pieces other windows
deliver (promotions from window 9, messaging delivery from window 16, CMS pages from window 6, analytics from
window 12) and owns what none of them do: campaigns, segments, product feeds, attribution, referrals, reviews, and
the Marketing section of the admin.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Channels first | Paid social/search **product feeds** and **email/SMS**; then referral/affiliate; loyalty last | For D2C brands feeds and owned channels carry most revenue; affiliates need volume first; loyalty needs repeat purchase data |
| Who runs it | **Both.** Campaigns, feeds, reviews, referral programmes are store-level (per brand). Segment *templates*, the cross-brand dashboard and shared budgets are organization-level | Brand teams work daily; HQ needs comparison and reuse. Same tenancy model as everything else (ADR 0001) |
| Loyalty | Phase 5, Talon.One or in-house on top of referral + segments | Needs a year of order history to be worth tuning |
| Where the truth lives | Orders, payments and stock stay in the core; marketing **reads events** and writes its own tables. No campaign ever mutates an order | Same rule as accounting (ADR 0003) |
| Attribution | First-touch and last-touch stored on the order at placement from UTM/referrer captured on the cart. Server-side only; no client pixels required for the numbers we report | Deterministic, privacy-safe, works when ad blockers strip pixels |
| Consent | Marketing consent is a product feature: per-channel opt-in with source and timestamp on `customer.consent`, enforced by the messaging worker; double opt-in for EU brands | Already in the schema; makes GDPR/ePrivacy a non-event later |

## Entities (all store-level unless noted; schema lands in packages/db at Integration 1)

| Entity | Fields (key ones) | Owner |
|---|---|---|
| campaign | store_id, name, type (`email` `sms` `paid_social` `paid_search` `affiliate` `referral` `landing`), status, starts_at, ends_at, budget_minor + currency, utm_source/medium/campaign, promotion_id?, segment_id?, landing_path?, external_ref (Klaviyo flow id, Meta campaign id) | 17 |
| segment | organization_id, store_id? (NULL = template), name, rules jsonb (orders_count, last_order_at, total_spent_minor, tags, consent, country…), materialised_count, last_materialised_at | 17 |
| segment_member | store_id, segment_id, customer_id (materialised, refreshed by job) | 17 |
| product_feed | store_id, channel (`google_merchant` `meta` `tiktok` `pinterest`), locale, currency, filters jsonb, mapping jsonb, url, status, last_published_at, item_count, errors jsonb | 17 |
| attribution | store_id, order_id, cart_id, touch (`first` `last`), utm_source/medium/campaign/term/content, referrer, landing_path, campaign_id?, captured_at | 17 (written by core at order placement from cart.metadata) |
| referral_program | store_id, name, status, referrer_reward_promotion_id, referee_reward_promotion_id, rules jsonb | 17 |
| referral | store_id, program_id, referrer_customer_id, code, referee_customer_id?, order_id?, status (`created` `clicked` `converted` `rewarded`) | 17 |
| review | store_id, product_id, order_line_item_id?, customer_id?, rating 1–5, title, body, status (`pending` `published` `rejected`), moderated_by, published_at | 17 |
| abandoned_cart (view/job) | derived from `cart` with status active and updated_at older than N hours; emits `cart.abandoned` | 1 (event), 17 (consumer) |

Existing entities used: `promotion` (window 9), `customer.consent`, `cart.metadata`/`order.metadata` (attribution capture in Phase 1), `store.settings.marketing` (feed defaults, sender identities).

## Events (packages/events v1 additions at Integration 1)

`campaign.launched`, `campaign.ended`, `feed.published`, `attribution.recorded` (or `order.placed` v2 with an `attribution` object — decided at Int 1),
`referral.converted`, `review.published`, `cart.abandoned` (moved from Phase 4 to Phase 2; window 1 emits it).
Consumers: window 16 (Klaviyo flows react to `cart.abandoned`, `referral.converted`), window 12 (marketing marts), window 15 (marketing spend as a cost line per legal entity).

## Admin API additions (contracts-v0.3 at Integration 1)

Store-scoped under `/admin/stores/{storeId}/marketing/…`: `campaigns` CRUD + `launch`/`end`, `segments` CRUD + `preview` (count) + `materialize`,
`feeds` CRUD + `publish` + `GET …/feeds/{id}/items` (paged), `referral-programs` CRUD, `referrals` list, `reviews` list + `moderate`,
`reports/attribution` (revenue by source/medium/campaign, first vs last touch), `reports/promotions` (uses per code, discount given, revenue).
Organization-level: `/admin/marketing/dashboard` (per-brand comparison), `/admin/marketing/segment-templates`.
Permissions: `store_staff` reads; `store_admin` writes; `analyst` reads reports only; publishing a feed or launching a paid campaign requires `store_admin`.

## Storefront (window 3, then window 17)

- **Phase 1 (now, issue filed):** capture `utm_*`, `referrer`, `landing_path`, `referral_code` on first visit into a first-party cookie, write them to `cart.metadata.attribution` when the cart is created, keep them through checkout. No contract change (metadata is free-form).
- Phase 2: referral landing page `/r/{code}`, feed-friendly PDP data (GTIN, brand, availability), review display on PDP.
- Phase 3: review submission after delivery (`shipment.delivered` triggers the request e-mail via window 16).

## Admin (window 4 now, window 17 later)

- **Phase 1 (now, issue filed):** reserve a **Marketing** entry in the Store view navigation gated on `store_staff`, rendering a placeholder page; the HQ view gets a **Marketing** dashboard entry gated on `analyst`/`owner`.
- Phase 2/3 (window 17 owns `apps/admin/src/app/(store)/[storeId]/marketing/**` and `(hq)/marketing/**`): Overview (revenue by channel and campaign, top promotions, abandoned-cart recovery rate), Campaigns, Segments (rule builder with live count), Feeds (status, item count, errors, publish), Referrals, Reviews (moderation queue), Consent (opt-in rates by channel).

## Integrations (adapters, per store credentials from Vault)

Google Merchant Center and Meta Commerce (feed files + API), Klaviyo (segments sync + flows, via window 16's messaging worker), Meta Conversions API and GA4 measurement protocol (server-side events from the bus, via window 12/16 pipeline), Trustpilot/Judge.me optional for reviews.

## Schedule

| When | Who | What |
|---|---|---|
| Phase 1 (now) | window 3, window 4 | UTM capture into cart metadata (#62); Marketing navigation placeholder (#63) |
| Integration 1 | main | tables, events, Admin API marketing paths → contracts-v0.3; Memory-17 tasks issued |
| Phase 2 | window 17 (parallel with the others) | 2.1 campaigns + attribution report · 2.2 product feeds (Google, Meta) · 2.3 segments + Klaviyo sync contract · 2.4 abandoned-cart flow (with 1 and 16) · 2.5 admin Marketing section v1 |
| Phase 3 | window 17 | referral programme, reviews + moderation, consent centre, HQ dashboard |
| Phase 5 | window 17 + 12 | loyalty, marketing marts, campaign ROI in BI |

## Ownership (docs/ownership.md row added)

`marketing/` → `apps/core/src/modules/marketing/**`, `apps/feeds/**`, `apps/admin/src/app/(store)/[storeId]/marketing/**`, `apps/admin/src/app/(hq)/marketing/**`.
Everything else stays with its current owner; window 17 requests changes through issues like every other window.
