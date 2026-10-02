# Pending manager pastes — written 2026-10-02 evening, undelivered

Main at the time of writing: see `git log -1`. Queue idle. One window takes heavy local runs at a time on this laptop.
If main has moved, only the sha in each block changes. Delete this file once all are relayed.

Open PRs at the time of writing: **#318** (core customers part A — BLOCK, four small fixes written locally as 0262af2, not yet pushed), **#320** (storefront #298, DRAFT — code verdict MERGE, one core run and two small changes owed).

Slots for 2026-10-03 (max 3): **3, 1, 6**. Window 10 stays parked until #320 merges. Window 4 (admin 2.5b) and window 5 (CI docket) follow when slots free. Machine order in the morning: window 3 → window 1 → window 6.

## Window 3 (storefront, `../wt-storefront`, existing session)

```
Manager: #320 reviewed (Fable, static): the CODE verdict is MERGE — no redirect is built from the request origin or headers in your paths, both layers of the safe-path rule apply, redirect_uri is the same string on both OIDC legs, sign-out unconfigured behaves as ruled, attribution fixed, carts never need SITE_URL, all six riders done. And CI answered the slow-page question: this head ran 67 tests on 2 workers — 65 passed, 2 skipped, 44.1 s, no retries (main: 34–46 s). The diff adds no meaningful work and the stalled requests were static chunks that bypass all changed code. So it is local start-up: playwright.config.ts:60 waits on `/`, Playwright resolves on the response HEADERS of /en-GB seconds after `next build` exits, and the workers then hit a cold server on a busy machine. Do not alternate branch/control runs — CI settled it.
The machine is YOURS first today. Three things, then mark ready:
1. Warm-readiness gate in scripts/e2e-server.mjs (not longer timeouts): report ready only after one page AND one static chunk have each answered quickly (e.g. two consecutive requests under 1 s). Then ONE full mock e2e locally, bounded and detached with output to a file — it should pass on the first Playwright-started run. Rule out the confound first: no STORE_API_URL exported in your shell.
2. Fail-closed as an ALLOW-list: config.ts:76 falls back to localhost whenever NODE_ENV is not "production" (or during the build phase). A pod started with NODE_ENV=staging or test would silently answer localhost — the original bug. Allow the default only for NODE_ENV development or test and the build phase; anything else without SITE_URL throws. Unit tests for staging / empty / unset.
3. The single core run of the checkout spec for riders 3 and 4 (one unit of seed stock): quote the output, the product and its stock before and after.
Also small: siteUrl() should return url.origin, not the raw string (a value with a path would diverge from siteOrigin()); the body should say the passing local Playwright-started run was 13/13 of a subset, add the CI numbers, and stop saying the mock e2e has not passed once it has.
Nits, not now (park): an empty E2E_STORE_API_URL gives a mock server while the spec thinks it is the core; rider 2 is bypassed by reuseExistingServer or an app-level .env.local; no route-level test for sign-in's redirect_uri; data-handle / data-currency are also not page text. For #312 later: refreshTokens and tokenEndpoint take the full OidcConfig — narrow them to the provider half so a token refresh never needs SITE_URL.
Then merge main, push, mark the PR ready, reply with the sha and say the machine is free. After #320 merges: #293 as PR six (routedDocuments, campaignIsLive and RoutedDocument are on main since #317, d46a273; the reader returns ABSENT keys for a missing schedule side; keep #302's force-dynamic exports). Window 6 will fix the cms preview handlers (#319) and can reuse your urlOnThisSite once #320 is merged.
```

## Window 1 (core, `../wt-core`, existing session) — only if #318 was NOT pushed and merged on 10-02

```
Manager: the machine is yours after window 3 reports it free (I will say). Then, as agreed on 10-02: the red proof for the letter-case test, customers + customers API + guard suites, typecheck, lint, format; merge main, push 0262af2 and the memory commits to core/phase2; update the PR body (the listMyOrders 400 as a recorded deviation on #303, the 788/6 figure being local, the three live customers tests running in no CI job). I verify the four fixes on the branch myself and queue #318 — no second review round. Then PR B (updateMe, listMyAddresses, addMyAddress): plan-paste first; it needs '400' on listMyOrders and listMyAddresses in the contract — tell me every other status it needs so I land contracts 0.4.9 once.
```

## Window 1 — if #318 WAS merged on 10-02 (see Memory-main's top bullet)

```
Manager: #318 is MERGED (sha in Memory-main's top bullet). git merge main. Next: PR B (updateMe, listMyAddresses, addMyAddress) — plan-paste first: module functions, the default-address rule (cleared then set in one transaction, no unique index exists), outbox + audit per mutation, PII in logs, the two paths joining REAL_STORE_PATHS so tokens stop reaching Prism. Tell me every status PR B needs that the 0.5.1 contract does not document; I land contracts 0.4.9 once, with '400' on listMyOrders and listMyAddresses. Heavy runs wait for the machine: window 3 has it first.
```

## Window 6 (cms, `../wt-cms`, existing session)

```
Manager: your second small PR — #319 (URGENT), accepted; read the issue and my decision comment. The preview and preview-exit handlers in src/lib/cms/handlers.ts build their redirects on the request's own URL, so behind the ingress they point at the pod's origin. It is broken, not steerable (Host / X-Forwarded-Host cannot move it; only the scheme follows X-Forwarded-Proto). Rule, same as storefront #298: the origin comes from SITE_URL read at request time on the server, never from the request URL or headers; fail closed when SITE_URL is unset outside local development; the #281 safe-path rule still gates the path.
Sequencing: window 3's #320 adds the helper (src/lib/site-origin.ts → urlOnThisSite) but is not merged yet. Write your change against that helper's signature and WAIT for my word that #320 is merged before you merge main and push — do not copy the helper into your paths.
Tests: one per handler, called as behind the ingress (pod origin, hostile forwarded host, public origin), asserting the full Location; red on the old code first. PR body may say Closes #319. git merge main first; unit tests of your own package are fine; ask before anything heavier. Hold the push until I confirm no queue is running.
```

## Window 10 (brands, `../wt-brands`) — only after #320 has merged

```
Manager: waking you for the ONE re-sync, as your RESUME HERE section describes. The starter now carries #299 (metadata in <head>), #305 (store-facts, slots test, pessimistic SEO gate), #309 (sitemap per request, e2e server built with a foreign SITE_URL), #316 (journey asserts the order, stock by property, sort/filter real against the core, mock-only account test, your two flake fixes), #317 (routedDocuments reader) and #320 (redirects from SITE_URL, fail-closed). Re-read the actual diff, not the issue numbers.
Known consequences: your placement pin goes red by design → delete it and assert correct placement; brand A's stub reader in test/cms-brand-content.test.ts needs `routedDocuments: async () => []`; a production-mode brand A without SITE_URL now answers 500 — your e2e server and README must set it; account.spec.ts now carries the mock-only test.
Then: re-measure SEO by hand (the perf gate is still vacuous for brands, #283) with ROBOTS_ALLOW_INDEXING=1 and close #142's two criteria in this PR if they hold; re-take the full-suite flake check on a quiet machine — ask me for the slot; #143's order-history criterion still waits for #303. One small PR, plan-paste if it exceeds ~20 calls.
```
