# Marketing section (admin, Store view)

Owner: **window 17 (marketing)** · Issue #149 · Contracts: Admin API 0.4.5.

Four screens over the marketing surface the core exposes: Overview, Campaigns, Segments, Feeds. The HQ
counterpart is `src/app/(hq)/marketing/`.

## Where the boundary with window 4 is

`apps/admin/**` is window 4's; these two folders and their tests are window 17's (docs/ownership.md). So:

- **Typed wrappers live here**, in `_api.ts`, not in `src/lib/api/admin.ts`. They use window 4's `adminCall`
  transport and their convention — the type parameter is the contract `operationId`, so
  `AdminResponse<'listCampaigns'>` is exactly the body the spec documents and a contract rename breaks the
  build rather than the screen.
- **Server actions live here**, in `_actions.ts`, not in `src/app/actions/`.
- **Nothing new is added to window 4's component space.** Every primitive is theirs: `Card`, `Badge`,
  `Button`, `DataTable`, `fields` / `use-contract-form`, `StatePanel` / `ActionRefusal`, the section guards.
- Anything of theirs that needs to change is a REQUEST. One has been through that loop: **#251** — their
  `SuccessBody` mapped 200 and 201 but not 202, so `materializeSegment` (and window 13's `eraseCustomer`) typed
  as `null`. Their fix merged as 1f21588 and the local workaround is gone.

## Conventions that are not optional here

- **Constants live in plain modules** (`_sections.ts`, `*-table.config.ts`, `segments/_rules.ts`) — never in a
  `'use client'` file. A constant exported from a client module becomes a client reference when a server
  component imports it, and an array that is no longer iterable is how that failure shows up.
- **Server actions cross the boundary bound**, `action.bind(null, storeId, id)`, never wrapped in an arrow.
- **No motion.** The design brief puts motion in the rail and nowhere else; nothing in these panels animates.
- **A refusal is data.** Every screen branches on `result.ok` and hands a failure to `ApiStatePanel`; every
  action returns `ActionResult` and a 401/403 renders `ActionRefusal`. No screen throws, and none goes blank.
- **UI permission gating is convenience only.** The server decides. Where a button is hidden (Save on a
  segment for a principal without `store_admin`) the same action still renders the refusal panel if invoked.

## The screens

| Screen                 | Reads                                                                             | Writes                                                            |
| ---------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Overview `page.tsx`    | `getAttributionReport`, `getPromotionReport`, `getAbandonedCartReport` (`viewer`) | —                                                                 |
| Campaigns `campaigns/` | `listCampaigns`, `getCampaign` (`store_staff`)                                    | `createCampaign`, `launchCampaign`, `endCampaign` (`store_admin`) |
| Segments `segments/`   | `listSegments`, `getSegment` (`store_staff`), `previewSegment` (`store_staff`)    | `updateSegment` (`store_admin`)                                   |
| Feeds `feeds/`         | `listFeeds`, `getFeed`, `listFeedItems` (`store_staff`)                           | `publishFeed` (`store_admin`)                                     |

Every number on Overview comes from `attribution` rows and orders, computed in the core — never from a pixel or
an ad platform's own figure. The page says so, because that is the whole point of the section.

## The rule builder

`segments/_rules.ts` is the editing model: a flat list of rows the UI can render, plus the two pure functions
that convert to and from the contract's `SegmentRules` — an **AND of ORs** over a closed seven-field predicate
set, frozen in contracts-v0.4.4.

`toRules` is the only thing that produces contract JSON, so it is the only thing the tests have to pin:

- `test/marketing/rule-builder.test.ts` — which values become numbers, which become arrays, what an incomplete
  row does (returns `null`, so half a rule is never sent), that `all: []` means _every_ customer rather than
  none, and that a saved rule set round-trips back into editable rows unchanged.
- `test-contract/marketing/marketing.test.ts` — posts `toRules(draft)` to Prism as a `SegmentInput` for
  **every field and operator of the closed set**. Prism validates bodies against the spec, so a green run is
  the contract itself accepting the JSON. That is why no copy of the grammar lives in this app.

Country codes are accepted in any case and upper-cased on the way out: refusing `nl` when we are about to
write `NL` anyway is a validation message nobody learns anything from.

## Not here yet

- Referrals, Reviews and Consent — Phase 3 (docs/marketing-scope.md).
- Feed and segment _creation_ forms. Campaigns has one; feeds and segments are created through the API for now
  and edited here.

## Run / test

```bash
pnpm --filter @platform/admin test                 # unit, includes test/marketing
pnpm --filter @platform/admin test:contract        # Prism, includes test-contract/marketing
pnpm --filter @platform/admin dev                  # needs `pnpm mock` for the Admin API
```
