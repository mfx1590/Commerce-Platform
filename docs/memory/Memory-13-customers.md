# Memory 13 — Customer accounts & identity
Window: 13 · Key: `customers` · Branch prefix: `customers/` · Model: Fable 5.1
Last updated: 2026-10-18 · Contracts: 0.4.20 / Store API 0.5.6 / events 0.3.5 (43e5436 on integration/customers-self-service, #482) · Last commit: (see Done) · Status: #470 MERGED (PR #487 = 89104c1, contracts-v0.4.20); customers/phase3 at main 96af509; #471 in build under #489

## Identity (does not change)
Owned paths (write) — the `customers/` row of docs/ownership.md (widened 2026-10-16, f96c9bc):
- `apps/core/src/modules/customers/**`, `apps/core/src/http/customer-routes.ts`, `apps/core/src/jobs/customer-*.ts`
- `apps/core/test/customers-api.test.ts`, `apps/core/test/admin-customers.test.ts`
- `apps/storefront-starter/src/app/[locale]/(account)/**`, `apps/storefront-starter/src/components/account-*.tsx`
Not mine: route mounting (store-routes.ts / admin-routes.ts, window 1 via REQUEST), the starter's `src/lib/**` and `test/**` and vitest config (window 3), `apps/core/CHANGELOG.md` and `apps/storefront-starter/CHANGELOG.md` (not in my row — CHANGELOG lines go in the PR body for the landing commit), brand copies (window 10).
Manager: "Manager session six", local_08108b05-8a7d-4006-ad3a-d58dc83b0723 (message: plan before building, PR number + head sha, when checks finish).

## Mission — Phase 3 (Multi-store & HQ)
Profiles, consent, GDPR export/delete, cross-brand identity linking, customer-facing account screens. Issues #470 (13.1), #471 (13.2), #472 (13.3), #473 (13.4); every issue ends with binding decisions + the shared tenancy/privacy risks.

## Done
- 2026-10-18 setup: install, packages built, fga:seed, branch at main 340bd39. Issues filed: **#482** CONTRACT CHANGE (Store API 0.5.6 updateMyAddress / deleteMyAddress / requestMyExport / deleteMe + events customer.export_requested v2 `requested_by_type`), **#483** REQUEST window 2 (delete the Keycloak user on customer.erased via the tombstone subject), **#484** REQUEST window 3 (vitest include `src/**/*.test.{ts,tsx}`).
- 2026-10-18 **#470 DONE — PR #487 merged as 89104c1** (bed5ad4 + review fix 25db707 + the manager's regenerated store.ts; tag contracts-v0.4.20; #470, #482 closed). The code: service.ts `updateCustomerAddress` / `deleteCustomerAddress` (customer-row lock, clear-then-set, oldest-heir rule), gdpr.ts `eraseMe` + `eraseIn` (tombstone subject kept), export v2 payload, 4 routes in customer-routes.ts + CUSTOMER_STORE_PATHS, README; starter: `(account)/account/{actions.ts,account.config.ts,account.test.ts,deleted/page.tsx}`, `account-address-forms.tsx`, `account-privacy.tsx`, page.tsx Privacy section. CHANGELOG lines in apps/core and the starter (manager asked for them in the commit; not in my ownership row — fine on the integration PR). Tests on the real contract: core 76/76 (customers.test, customers-api.test, admin-customers.test), starter unit 4/4 (include override), lint + typecheck green for core and starter.

## In progress
- **#471 (13.2) consent ledger — ONE commit on `customers/phase3-consent`, cut from the manager's 7e2e99f (integration/customers-consent), pushed; waiting for the integration PR / review.** The carrier commit 21b4cb0 on customers/phase3 holds the same work (cherry-picked; the memory conflict resolved with my version). Gates on the REAL contract: core customers suites 88 + 1 todo, starter 612/612, window 17 segments 55/55 read-only, core + starter typecheck, root lint. REQUEST #492 to window 1 = the routers.push line for customersAdminRouter. Gates on the local #489 mock: core customers suites 88 + 1 todo, starter 612/612, window 17 segments 55/55 read-only, core + starter typecheck, eslint, root lint. Was: building under CONTRACT CHANGE #489 (accepted; condition: a refuser is never in a re-consent audience → REQUEST #491 to window 17, proof test with it.todo). Local mock = the #489 diff applied uncommitted to packages/db, packages/contracts, packages/events (scratchpad `apply-contract-489.mjs`; NEVER `git add packages/`). The manager assembles the contracts + db commit on `integration/customers-consent` and sends the sha; then ONE code commit on a side branch cut from it. Before sending the sha: core customers suites, the WHOLE starter suite, window 17's segment tests (read-only), typecheck, lint.

## Next — Phase 3
- [ ] #471 consent ledger (needs a CONTRACT CHANGE: migration customer_consent, Store getMyConsents/putMyConsents, Admin listCustomerConsents)
- [ ] #472 export delivery job (`apps/core/src/jobs/customer-export.ts`; CONTRACT CHANGE: migration customer_export, event customer.export_ready v1, Store getMyExport, Admin getCustomerExport/listCustomerExports)
- [ ] #473 identity linking (owner Q1–Q3 first; CONTRACT CHANGE: customer_identity RLS organization-only, Admin getCustomerIdentity)

## Decisions made (with reasons)
- **#471 is NOT gated on #491** (manager 2026-10-18): no email provider exists yet and opted-out customers already sit in not_granted; #491 is on the launch list before any re-consent send. The `never_asked` SegmentPredicate contract line belongs to #491's landing (window 17 + manager), NOT to #489. My proof test keeps the never_asked assertion as it.todo(#491).
- **Every /me write locks the customer row before judging status** (#487 review): one locked read in `locate` instead of a re-check in each path — the lock is where the status truth is.
- **Tombstone subject (manager 2026-10-18, #482, lawyer list):** erasure keeps `keycloak_subject` (admin and self-service alike). Without it the same login finds no row (email replaced) and re-provisions a fresh account; with it every route is 401 and `DELETE /me` replays as 202 no-op. Opaque IdP id, no PII; meaningless once window 2 deletes the user (#483).
- **No mount REQUEST for Store API customer routes:** `CUSTOMER_STORE_PATHS` (my file) is spread into window 1's `REAL_STORE_PATHS`, and `mountCustomerRoutes` owns the whole `/store/customers` prefix. The HTTP test proves each new path answers from my router (a fallback mock would answer `{mock:true}`).
- **deleteMyAddress answers 200 `{ items }`** (manager on #482): no first 204 in the Store API, and the page needs to see where a default went. The service returns the remaining list in `listCustomerAddresses` order.
- **deleteMyAddress heir rule:** a default the deleted (or `false`-patched) address held goes to the OLDEST remaining address; `false` on the only address is ignored. Keeps "a customer with addresses always has a default" (window 17's segment country reads the default shipping address).
- **Self-service erase on a token with no row yet:** resolve-or-provision first (a verified email adopts a guest row, then erased); a brand-new subject gets a row and loses it in one transaction. Simpler than re-implementing the collision rule; documented in README.
- **Starter server actions live in `(account)/account/actions.ts`** and call the client's public generic `request()`; window 3's `client.ts` / `account-actions.ts` untouched. Pure rules in `account.config.ts` (a plain module, not `'use client'`, so constants are safe in server code).
- **Local contract mock = uncommitted edits in packages/contracts + packages/events** (scratchpad script `apply-contract-mock.mjs`), rebuilt with `pnpm --filter @platform/contracts build && pnpm --filter @platform/events build`. NEVER `git add packages/`.

## Blocked / waiting
- The integration PR for #470 (manager). #483 (window 2) and #484 (window 3) are non-blocking.

## Gotchas learned
- Window 17's `segmentQuery(rules, projection)` binds the STORE ID as `$1` itself: call it with `[storeId, ...q.params]` (as previewSegment does), never `q.params` alone.
- The starter has no Store API `getStore` field for the privacy-policy version: the account page reads `PRIVACY_POLICY_VERSION` from the environment (`privacyPolicyVersion()` in account.config.ts) and must be kept equal to `store.settings.privacy.policy_version` — a later contract item could expose it on `GET /store`.
- **STANDING RULE (manager 2026-10-18, after #487's first queue run failed on "generated files are current"):** after ANY contract yaml edit, even description text, run `pnpm --filter @platform/contracts generate` (and `@platform/events generate` for schemas) and commit the generated files.
- `pnpm test --filter @platform/core` (full suite, 2026-10-18): 1078 passed, 4 FAILED in window 2's live hq-rbac tests (`src/modules/hq-rbac/test/roles.test.ts` ×3, `scope.test.ts` ×1 — live Postgres + OpenFGA + Keycloak). Not my code; the run straddled my `fga:seed` (new model id on the shared store) and the branch move. The customer suites are green on their own. Report, do not chase.
- No python on this machine: scripted edits go through node. `String.replace` with a replacement string containing `$'` corrupts the file (it inserts the text after the match) — always `s.replace(needle, () => replacement)`.
- A bash heredoc with a `'` inside `<<'EOF'` content is fine, but the WHOLE command fails to parse (nothing runs) when a `'` appears in the surrounding command line — write long code to a scratch file with Write and `cat >>` it.
- The starter's typecheck needs `@platform/cms` built (`pnpm --filter @platform/cms build`); `pnpm -r --filter "./packages/*" build` does not cover `cms/`.
- The starter's vitest include is `test/**/*.test.ts` only: a test next to my code needs an include override to run (scratchpad `vitest.account.config.ts`, run from apps/storefront-starter with `--config`). REQUEST #484 asks window 3 to widen it.
- `customers-api.test.ts` "oversized JSON → 413" test is flaky (`read ECONNRESET`) — passed on the rerun, unrelated to my change.
- `apps/core/CHANGELOG.md` / starter CHANGELOG are NOT in my ownership row (check-ownership.sh has no exemption): put the lines in the PR body.

## How to run & test this package
- Setup (done 2026-10-18): `pnpm install --frozen-lockfile`; `pnpm -r --filter "./packages/*" build`; `pnpm --filter @platform/cms build`; `pnpm --filter @platform/auth-sdk fga:seed` (writes this worktree's OpenFGA ids into .env).
- Tests: `pnpm --filter @platform/core exec vitest run src/modules/customers test/customers-api.test.ts test/admin-customers.test.ts` (throwaway databases; ~3 min). Starter unit: see gotcha above.
- Gates: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/core` (long: background, output to a scratch file).
- Per-file: `pnpm exec prettier --write <files>`; `pnpm exec eslint --max-warnings 0 <files>`; `pnpm --filter @platform/core typecheck`; `pnpm --filter @platform/storefront-starter typecheck`.
