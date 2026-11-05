# Start message — Window 3: Storefront starter & UI kit (Phase 5, #609)
Paste into a NEW Claude Code session opened IN the folder `C:\Users\mehdi\Desktop\wt-storefront` (worktree option OFF).
The Phase 1 version of this file is in git history.

---

You are window 3 — STOREFRONT (storefront starter & UI kit), Phase 5. Your manager is the repo-root session "Manager session eleven". It reviews, decides and merges; message it, never the owner, about your work.

Read, in this order: CLAUDE.md, docs/ownership.md (row `storefront/`), docs/memory/Memory-main.md (only the first bullet under "Current status" and "Global gotchas"), docs/memory/Memory-3-storefront.md (last updated 2026-10-10, so a lot has moved since; trust main over it), docs/plan/phase5-plan.md (decision D10), apps/storefront-starter/CLAUDE.md and README, then GitHub issue #609 with ALL its comments. The last comment is window 9's hand-over of the recommendations API; read it in full.

Two of window 9's caveats are OUT OF DATE, and main wins:
- The route IS mounted now (REQUEST #624, done in #698): a real core answers `GET /store/recommendations` through `moduleStoreRouters()`, before the fallback proxy.
- The dev catalogue was re-published (#634), so dev ClickHouse now maps ordered variants. The rail on dev can still be empty until the nightly `index-recommendations` job has run on the dev data. An empty rail is a valid state, not a bug; the Prism mock (`pnpm mock`, :4010) or your own fixtures show a populated one.

Then:
1. Your worktree is on `storefront/phase3`, 1005 commits behind main, with ONE local commit, a11a4680 (a memory note, 10-10), that is on no remote branch. Do not lose it. Look at what it says, and carry anything still true into your memory file on the new branch.
2. Rewrite `.claude/CLAUDE.local.md` (yours, git-excluded) to say: "I am window 3 (storefront). I write only: apps/storefront-starter/**, packages/ui/**. Contracts are frozen at the tag named in Memory-main. My memory file is docs/memory/Memory-3-storefront.md. Branch: storefront/phase5-609-rail."
3. Set up: `git fetch origin` · `git switch --no-track -c storefront/phase5-609-rail origin/main` (`--no-track`: otherwise the upstream is origin/main and a bare `git push` could reach main) · `pnpm install --frozen-lockfile` · rebuild the workspace packages. Push the first time with `git push -u origin storefront/phase5-609-rail`. No docker commands, ever: the manager runs the shared stack.
4. Build #609 in the starter: a PDP "Frequently bought together" rail (`kind=bought_together&product_id=`) and a cart "You may also like" rail (`variant_ids=` from the cart lines), both from `listProductRecommendations`.
   - Server-rendered, with no layout shift, and hidden when empty.
   - The existing product card renders the items unchanged (same `ProductSummary` shape).
   - Fetched IN PARALLEL with the page data: a slow or failed recommendations call never delays or breaks the PDP or cart.
   - i18n for every starter locale (the card text already comes in the store's locale; only your headings need strings).
   - Inside the storefront perf budget on every leg.
5. Analytics: `recommendation_viewed` / `recommendation_clicked`, with the SERVED `kind` and the surface (`pdp` / `cart`), under the consent rules decided 2026-10-23. **Those two events are NOT in `data/cdp/tracking-plan.json` yet.** That file is window 16's: file `REQUEST: tracking plan — recommendation_viewed / recommendation_clicked (#609)` with the exact entries you need, and build against a local definition until it lands. Never edit data/cdp yourself.
6. Out of scope for you: the three brand storefronts (`apps/storefronts/brand-*`) get the rail by the brand re-sync, which is window 10's step after your PR merges. Say in your PR what the brands need to pick up.
7. Rules:
   - One window measures at a time. Ask the manager for "the machine" before any Lighthouse, perf or other long run, and report "machine free" after.
   - Long runs go detached, output to a file, with bounded polling.
   - Nothing secret-shaped in tests (use words).
   - No closing keyword next to an issue number in a commit message; the PR body says "Closes #609".
   - Merge main before pushing.
   - Run the FULL starter suite (the i18n and bundle-README checks live there), plus lint and typecheck, before the PR.
   - Update your README, CHANGELOG and memory file with the change.
8. Message "Manager session eleven" twice per PR: when it is up (PR number + head sha), and when every check has finished. After that, hold every push until the manager confirms the merge. If a decision blocks you, message the manager with the options and your recommendation, and keep working on what does not depend on it.

Start by summarising in five lines what you will build and how you will test it (including how you prove "no layout shift" and "a failed call never blocks the page"), send that summary to the manager as a message, then begin.
