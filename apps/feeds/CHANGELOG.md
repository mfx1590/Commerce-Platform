# Changelog — @platform/feeds (window 17)

## 0.1.0 — 2026-09-08 · created for 2.2 product feeds (#146)

- `src/storage.ts`: `parseFeedPath` (strict `<store_code>/<feed_id>.<ext>` matching — refuses rather than
  sanitises) and `FeedReader` (reads under the artifact root only, scoped to the instance's store codes).
- `src/server.ts`: `GET /feeds/{store_code}/{feedId}.xml|csv`, `HEAD` on the same, `GET /health`, everything
  else 404 with one indistinguishable body. `resolveConfig` reads `PORT`, `FEEDS_DIR`, `FEEDS_STORE_CODES`,
  `FEEDS_MAX_AGE` and refuses to start in production without an explicit store-code allowlist.
- `src/main.ts`: listen + graceful shutdown on SIGINT/SIGTERM.
- Node's own `http`; no framework and no runtime dependencies at all.
- 13 tests: serving both formats, HEAD, health, scope refusal, no directory listing, traversal refusals,
  method refusal, `parseFeedPath` and `resolveConfig` including the production guard. No database.
- **No Dockerfile yet** — `**/Dockerfile` is window 5's path (REQUEST filed with the 2.2 PR).
