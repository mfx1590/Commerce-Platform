# Memory 13 — Customer accounts & identity
Window: 13 · Key: `customers` · Branch prefix: `customers/` · Model: Fable 5.1
Last updated: 2026-10-18 · Contracts: 0.4.20 / Store API 0.5.6 / events 0.3.5 (43e5436 on integration/customers-self-service, #482) · Last commit: (see Done) · Status: #470–#473 ALL MERGED (#487, #496, #501, #505 = ebb203f = contracts-v0.4.24, + the manager's #506 deadlock fix = efdafa5); docket EMPTY — idle after the README-nit PR

## Identity (does not change)
Owned paths (write) — the `customers/` row of docs/ownership.md (widened 2026-10-16, f96c9bc):
- `apps/core/src/modules/customers/**`, `apps/core/src/http/customer-routes.ts`, `apps/core/src/jobs/customer-*.ts`
- `apps/core/test/customers-api.test.ts`, `apps/core/test/admin-customers.test.ts`
- `apps/storefront-starter/src/app/[locale]/(account)/**`, `apps/storefront-starter/src/components/account-*.tsx`
Not mine: route mounting (store-routes.ts / admin-routes.ts, window 1 via REQUEST), the starter's `src/lib/**` and `test/**` and vitest config (window 3), `apps/core/CHANGELOG.md` and `apps/storefront-starter/CHANGELOG.md` (not in my row — CHANGELOG lines go in the PR body for the landing commit), brand copies (window 10).
Manager: **"Manager session eight", local_875d6fa6-5b47-4924-80ba-464d535ee3d2** (since 2026-10-23; sessions six and seven are history) (message: plan before building, PR number + head sha, when checks finish).

## Mission — Phase 3 (Multi-store & HQ)
Profiles, consent, GDPR export/delete, cross-brand identity linking, customer-facing account screens. Issues #470 (13.1), #471 (13.2), #472 (13.3), #473 (13.4); every issue ends with binding decisions + the shared tenancy/privacy risks.

## Done
- 2026-10-24 **#580 DONE — PR #583 merged as 738c34a** (customer.erased v2 with the pre-tombstone email_hash; events 0.6.2; code b70f8e2 on customers/phase4-580). Window 13 idle; Phase 3 docket and the Phase 4 producer change complete.
- 2026-10-19 **#473 DONE — PR #505 merged as ebb203f** (contracts-v0.4.24, db 0.3.11 with 0196; #473, #504 closed). Main went red on my concurrent guest-merge test (40P01 deadlock: the adopting sign-in held its guest customer row and waited for the guest identity while the other brand's sign-in held the identity and waited for the row); the manager fixed it in **#506 = efdafa5** (db 0.3.12 / 0197: link_customer_identity locks the guest's customer rows FOR UPDATE SKIP LOCKED before the identity — contention = no merge; the re-point filters organization_id) and rewrote the test's interleaving-dependent assertion. Dev DB at 0197. Review nit: the README still had the old function signatures → README-nit PR.
- 2026-10-18 **#472 DONE — PR #501 merged as 4d3379f** (contracts-v0.4.23, db 0.3.10 with 0195, events 0.3.6; #472, #498 closed; the dev database migrated to 0195). Code = 0e11618 on customers/phase3-export. Review nits for the NEXT PR: `account-exports.tsx` links `/account/exports/{id}` without the locale prefix (one middleware redirect — prefix it, e.g. via the i18n `Link`/`getPathname`), and the exports panel has no starter unit test.
- 2026-10-18 **#471 DONE — PR #496 merged as 6231659** (contracts-v0.4.21, db 0.3.9 with 0194; #471, #489, #492 closed; the dev database migrated, its one projection became one pre-ledger row). Code = 8cf677a on customers/phase3-consent (carrier 21b4cb0 on customers/phase3).
- 2026-10-18 setup: install, packages built, fga:seed, branch at main 340bd39. Issues filed: **#482** CONTRACT CHANGE (Store API 0.5.6 updateMyAddress / deleteMyAddress / requestMyExport / deleteMe + events customer.export_requested v2 `requested_by_type`), **#483** REQUEST window 2 (delete the Keycloak user on customer.erased via the tombstone subject), **#484** REQUEST window 3 (vitest include `src/**/*.test.{ts,tsx}`).
- 2026-10-18 **#470 DONE — PR #487 merged as 89104c1** (bed5ad4 + review fix 25db707 + the manager's regenerated store.ts; tag contracts-v0.4.20; #470, #482 closed). The code: service.ts `updateCustomerAddress` / `deleteCustomerAddress` (customer-row lock, clear-then-set, oldest-heir rule), gdpr.ts `eraseMe` + `eraseIn` (tombstone subject kept), export v2 payload, 4 routes in customer-routes.ts + CUSTOMER_STORE_PATHS, README; starter: `(account)/account/{actions.ts,account.config.ts,account.test.ts,deleted/page.tsx}`, `account-address-forms.tsx`, `account-privacy.tsx`, page.tsx Privacy section. CHANGELOG lines in apps/core and the starter (manager asked for them in the commit; not in my ownership row — fine on the integration PR). Tests on the real contract: core 76/76 (customers.test, customers-api.test, admin-customers.test), starter unit 4/4 (include override), lint + typecheck green for core and starter.

## In progress
- 2026-10-19 **REQUEST #513 (window 2's #483 wiring): `apps/core/src/jobs/customer-erasure.ts`** — the Medusa job + CLI that runs auth-sdk's `createCustomerErasureConsumer(...).runOnce({ limit })` (customers-realm admin client from `KEYCLOAK_CUSTOMERS_ADMIN_CLIENT_ID/_SECRET`, realm `KEYCLOAK_REALM_CUSTOMERS`, cron `CORE_CUSTOMER_ERASURE_CRON` */5); one commit on `customers/phase3-erasure-job` cut from the manager's 06fdd7d (integration/customers-erasure); test in customers-api.test.ts with a fake Keycloak client (deletes the tombstone subject once; a second run settles nothing). Then idle.
- README-nit PR (customers README: the landed function signatures without the org parameter + the 0197 contention rule) — then IDLE: the Phase 3 docket (#470–#473) is done. #484 (starter vitest include) waits for window 3; #483 (window 2) and #491 (window 17) are theirs.

## Next — Phase 3
- [ ] #472 export delivery job (`apps/core/src/jobs/customer-export.ts`; CONTRACT CHANGE: migration customer_export, event customer.export_ready v1, Store getMyExport, Admin getCustomerExport/listCustomerExports)
- (Phase 3 docket complete: #470 #471 #472 #473 merged.)

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
- 2026-10-24: Docker restarted and OpenFGA lost its store — run `pnpm --filter @platform/auth-sdk fga:seed` before any auth test on the next activation (stale ids = 503 on every admin call).
- **Lock order in SECURITY DEFINER functions (#506):** a function that locks rows the caller's transaction may already hold (the adopted guest customer row) must take them first (or SKIP LOCKED), or two sign-ins deadlock (40P01). A concurrency test must not assert on the interleaving (who merged) — only on the invariant (merged once, adopter keeps its row).
- The link must also run on an ADOPTED row (it may point at a guest-only identity the function merges), not only when identity_id is null; and the cross-brand erasure's last unlink already deletes the identity — judge "deleted" by a final SELECT, not by the DELETE's rowCount.
- A new event topic needs THREE things in packages/events: the schema folder, `envelope/v1.json`'s topic enum, and `generate` — the validator refuses an envelope whose topic is not in the enum (found building #472).
- pg refuses a query whose parameter list has an unreferenced placeholder ("could not determine data type") and "inconsistent types" when one placeholder feeds columns of different types — number placeholders by hand, never by cascading replace.
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
