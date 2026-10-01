# Pending manager pastes — written 2026-10-01 night, undelivered

Main at the time of writing: see `git log -1` (after #299 = 39e7321). Queue idle. No window may push while a queue runs.
If main has moved, only the sha in each block changes. Delete this file once all four are relayed.

Slots for 2026-10-02 (max 3): **10, 3, 1**. Window 6 takes the first slot that frees (window 10 after its #301 fix merges is the likely one).

## Window 10 (brands, `../wt-brands`, session open)

```
Manager: #301 verdict BLOCK — four fixes, one push, reply with the sha. Verified sound, don't re-argue: ownership, zero closing keywords, counts 32/21, strict-mode hard-fails, the variant walk failing rather than skipping, the #274 pin on raw bytes, the seed --yes gate, the contrast de-dup, and Refs #143 as the right reading.
1. Order history and the customer's identity come from PRISM, not the core: the core mounts no /store/customers* route (filed as #303 for window 1), so account.spec.ts:87 (jane@example.com from getMe) and :92 (`Order #1000`, the mock's example and a hard-coded dataset value) prove nothing about the real stack — while the body and CHANGELOG say both halves run against it. Fix: keep the real parts (Keycloak redirect, return URL, session, sign-out); untick and NAME "order history against the core — blocked on #303"; the #1000 assertion goes or is labelled mock-only; body + CHANGELOG say exactly which requests the core answered and which Prism answered.
2. Buy and account are never tied and almost nothing server-produced is asserted. In journey.spec.ts (yours; checkout.spec.ts is the starter's and is routed as #304): capture the order number on the confirmation page and assert it is the order just placed — line titles, quantities and total in minor units against values captured from the cart at runtime. Correct the header at :7-9, which claims the test payment provider and a real order on the confirmation; it does neither today. Either make it true or delete the claim.
3. Every run places a real order and nothing releases the stock; the reviewer recomputed 35 units on the first seed product, shared with every suite on the same publishable key. Either pick a product by property with ample stock and state the run budget in the README, or make your own spec stock-neutral. Say which.
4. "PLP filters": a sort click asserting URL + h1 is not a filter test. Assert an observable effect of sort and of one category filter in journey.spec.ts, or untick and name it.
Also in this push: the preserved playwright.config.ts lacks the starter's STORE_API_URL forwarding (with reuseExistingServer false, #295's CI run would boot against Prism) — add it and note it on #295; README:96-98 and :129 still say "until #212" / "opts in at 2.5"; README:67 still has Stone #746C60 (token is #6B6357).
Nits, not now (park): the placement pin passes on an error page or a missing </head> and never checks status; footer no-duplicate test has no non-empty guard; lastReviewed guard matches only the word; the --yes gate is hand-verified only.
STOP the core on :9000 and brand A on :3101 that you left running — I did not need them. News: #299 merged (39e7321) — the starter now serves metadata in <head> for every user agent; your next re-sync turns your placement pin red by design, which is the signal to re-measure SEO and close #142's two criteria. Do that re-sync as its own small PR AFTER this one merges. git merge main first; no `docker exec`; no queue is running.
```

## Window 3 (storefront, `../wt-storefront`, session open)

```
Manager: #299 MERGED as 39e7321, #274 closed. The reviewer rebuilt your branch and reproduced it: 60/60 probes in <head>, old config 40/40 red, unit pin 6/5/2 red under three mutations. git merge main, then bring over ONLY the #286/#278 commit and open PR two. No queue is running.
Required rider in PR two: the new 0.95 SEO gate does not guard the fix. LHCI's default aggregation is "optimistic" (best of the runs), so main's old 100/92/92 would also have passed 95, and the "median of 3" wording in perf.mjs:142, CLAUDE.md:26 and README:507 is wrong. Set aggregationMethod "pessimistic" on categories:seo (and check what performance uses), correct the three texts, and show the gate RED against the pre-#299 config before green.
Also for PR two (small): an e2e case for an EMPTY User-Agent header (your middleware handles it; nothing tests it); README cost note mentions soft navigations also wait on metadata; Memory-3 drift (warm 10–12 ms vs 9–16 in the body, "Docker daemon is DOWN" next to "against the Docker mock", #299 not recorded).
#300 is ACCEPTED as you wrote it; window 6 builds it on its next wake. #293 stays parked at 2587ec9 until that merges, then swap the local schedule rule for the exported one and the method detection for a typed call.
Your docket after PR two, each its own small PR, in this order: #302 (sitemap origin baked at build — your find, filed), #304 (checkout.spec asserts nothing server-produced, drains seed stock, "filters" is a sort click — brands inherit it by re-sync), #298 (sign-out derives post-logout URI from the request origin vs SITE_URL — unverified lead, establish first). #293 slots in whenever #300 lands. Plan-paste any of them that exceeds ~20 calls. No `docker exec`; no closing keyword in commit messages unless the commit finishes the issue.
```

## Window 1 (core, `../wt-core`, FRESH session, model Fable, "worktree" unchecked)

```
You are window 1 (core). Read, in this order: CLAUDE.md, .claude/CLAUDE.local.md, docs/memory/Memory-1-core.md, then `git log --oneline -20` and `git status`. Summarise in five lines where the previous session stopped. Continue with the first item under "In progress" (or the first unchecked item under "Next" if In progress is empty). Do not redo anything under Done. Keep the memory rule: update the memory file after every task and before every commit; /compact after updating when context is long.

Manager: waking your quiet window for the routed BUNDLE — four items, one PR (or two if the split reviews better; say which when you open) — plus one assessment. Main is at contracts-v0.4.7; git merge main, pnpm install, rebuild workspace packages, .env DB/Redis rows on 127.0.0.1, fga:seed in your worktree (OpenFGA is a fresh in-memory store since the 10-01 Docker restart).
1. #265 — unmounted /admin/* routes answer 401 (Medusa's auth) instead of the contract's 404: route-not-found must be decided before auth so the admin's not-implemented panel gets its 404. Don't weaken auth on MOUNTED routes.
2. #279 core side (spec landed, fields currently optional): registry set-replacement for store_currency/store_locale (delete-not-in-set except the default, insert new, is_default kept, outbox in the same transaction; omitted field = unchanged), revokeApiKey (idempotent; 409 last_live_key when it's the last publishable key with revoked_at IS NULL), updateDomain primary move in one transaction (clearing the current primary = 409). getStore/listStores/createStore/updateStore return currencies and locales — the contracts file is the manager's: return the fields, then tell the manager and they flip required in a one-line contracts follow-up. Exact semantics are in #279 and its landing comments.
3. #284 — X-Contracts-Version: <CONTRACTS_VERSION> header on /health and /admin/* responses; /health body stays plain OK.
4. While you're in the registry: your Phase 3 backlog's two parked #233 nits may ride along if trivial (side-effect-import guard, 403-before-key test) — your call, named in the PR body either way.
5. ASSESS ONLY, no building: #303 — the core mounts no /store/customers, /me, /me/addresses or /me/orders route; with the fallback on, Prism answers them, so a signed-in customer sees the mock's example order, never their own. Read the issue and reply with a plan-paste: what exists as module functions, the tenancy rule (customer token store_code vs publishable key, a customer reads ONLY their own rows), guest-order → customer linking at placement, PII in responses/logs/events, outbox for mutations, size in PRs. I decide scope and order after the plan; it is a go-live blocker for brand A accounts.
Environment: Docker's backend crashed four times on 10-01 before 19:14 (cause unknown), stable since. Run NO `docker exec` and no compose/recovery commands; reach Postgres/Redis/Keycloak through the published ports. Check :9000 before starting a core process and never kill a process you did not start. If a port closes mid-run: stop, note the time and your last command, report.
Standing rules: hold every push until the manager confirms no queue is running; one plan-paste first if any single PR exceeds ~20 calls; no closing keyword next to an issue number in a commit message unless that commit finishes the issue; test keys are words.
```

## Window 6 (cms, `../wt-cms`, FRESH session, model Sonnet, "worktree" unchecked) — when a slot frees

```
You are window 6 (cms). Read, in this order: CLAUDE.md, .claude/CLAUDE.local.md, docs/memory/Memory-6-cms.md, then `git log --oneline -20` and `git status`. Summarise in five lines where the previous session stopped. Continue with the first item under "In progress" (or the first unchecked item under "Next" if In progress is empty). Do not redo anything under Done. Keep the memory rule: update the memory file after every task and before every commit; /compact after updating when context is long.

Manager: waking you for ONE small PR — #300, accepted as written; read the issue and my decision comment. git merge main, pnpm install, rebuild workspace packages. Ownership changed on 09-29: your row is now cms/* (top-level files), cms/src/**, cms/scripts/**, cms/test/** and the storefront-starter cms paths; cms/brand-*/** belongs to window 10 — do not touch it.
Build: CmsReader.routedDocuments(locale) returning type, slug, startsAt, endsAt for page / legal / campaignLanding; seo.noIndex and the home page filtered at the source (mind the coalesce point in the issue — a document with no seo object must still be returned); schedule returned, not applied; no next/headers anywhere on this path; [] on failure with the usual single warning; the four cache tags; export campaignIsLive and the RoutedDocument type from the index.
Tests: one per filter (noIndex, home, missing slug, no-seo-object still returned), one proving the path does not import next/headers, the empty reader and any stub reader gain the method so clones keep compiling. Show one filter test red first. PR body may say Closes #300; commits say Refs. Window 3's #293 is built against a fake of this signature and lands after you merge — do not change the signature without telling me.
Rules: merge main before pushing; hold the push until I confirm no queue is running; no `docker exec`; test keys are words.
```
