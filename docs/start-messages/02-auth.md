# Start message — Window 2: Auth & RBAC (Phase 5, fresh session)
Paste into a NEW Claude Code session opened IN the folder `C:\Users\mehdi\Desktop\wt-auth` (worktree option OFF).
Earlier versions of this file are in git history.

---

You are window 2 — AUTH (Keycloak, OpenFGA, auth-sdk, hq-rbac), Phase 5, a FRESH session continuing a task the previous window-2 session started. Your manager is the repo-root session "Manager session nine".

Read, in this order: CLAUDE.md, .claude/CLAUDE.local.md, docs/ownership.md (row `auth/`), docs/memory/Memory-main.md (the first two bullets under "Current status" and "Global gotchas" only), docs/memory/Memory-2-auth.md (its "In progress" section holds the full #632 state), then GitHub issue #632 and the Fable review comment on PR #626 that led to it.

Then:
1. `git fetch origin` and work on `integration/phase5-allowlist` (an integration/ branch, because it carries the labelled window 1/15 exception commits; the previous session pushed it): `git switch --no-track -c phase5-allowlist origin/integration/phase5-allowlist`. Push ONLY with `git push origin HEAD:refs/heads/integration/phase5-allowlist`, never a bare push. `pnpm install --frozen-lockfile`, rebuild the workspace packages, then `pnpm --filter @platform/auth-sdk fga:seed`. No docker commands.
2. STATUS (2026-10-27): #632 is already BUILT and pushed on integration/phase5-allowlist (7 commits, unit/static green; see Memory-2). Your job: ask the manager for THE MACHINE, run the live suites (auth-sdk full incl. service-clients + provisioning live, core full, accounting full), fix anything they find, then open ONE PR "Closes #632" listing the three labelled exception commits. For reference, what was built and must stay true:
   - one enforcement point in the staff token verifier (next to the read-only guard), with a per-client allowlist code constant keyed by api (`admin` | `finance`);
   - in the core, a pre-routing `matchOperation(method, path)` over admin-api.yaml, with a test that walks EVERY operation and asserts an exact, unambiguous match (literal segments beat parameters; trailing slash, encoding and case as Express handles them);
   - hq-rbac's second layer refuses a service client when its own matched operationId differs;
   - accounting passes `req.method` as is plus `api: 'finance'`;
   - integration-exception commits for window 1/15 files, labelled in the subject;
   - the `provision:service-accounts` CLI (dry-run, prints ids only, refuses without OPENFGA_STORE_ID) and the production section of infra/keycloak/README;
   - tests: allowed reads 200; analytics-sync on listOrders → 403 with reason `service_client_operation_not_allowed` from THIS layer; humans unaffected; the full core + accounting suites.
3. Rules: one window measures at a time, so ask the manager for "the machine" before any live or long run and report "machine free" after; nothing secret-shaped in tests; no closing keyword next to an issue number in a commit message unless that commit finishes the issue; never reimport a realm; additive changes to the shared Keycloak/OpenFGA only.
4. One PR "Closes #632", acceptance criteria in the body, the exception commits listed. Message the manager when the PR is up (number + head sha) and when checks finish. Update your memory file after every task and before every commit.

Start by summarising in five lines where the previous session stopped and what you'll build first.
