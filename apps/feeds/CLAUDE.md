# @platform/feeds

## Purpose

Serves the published product feed files (Google Merchant RSS/XML, Meta CSV) that the core's marketing module
generates. Bytes only: no database, no catalogue, no mutations.

## Owner

window 17 (marketing). `Dockerfile` is window 5's (infra) per docs/ownership.md.

## Run / test

- `pnpm --filter @platform/feeds dev` — tsx watch on `src/main.ts`; `GET http://localhost:4020/health` → 200.
- `pnpm --filter @platform/feeds test` — Vitest, no database and no docker stack (~1 s).
- `pnpm --filter @platform/feeds typecheck` / `build` (tsc → `dist/`) / `start` (`node dist/main.js`).

## Public API

- HTTP: `GET /feeds/{store_code}/{feedId}.xml|csv`, `HEAD` on the same, `GET /health`. Nothing else.
- `src/index.ts` exports `createFeedServer`, `createFeedHandler`, `resolveConfig`, `FeedReader`,
  `parseFeedPath`, `CONTENT_TYPE` — used by the tests and by whatever embeds the server later.

## Constraints

- **The key convention `<store_code>/<feed_id>.<ext>` is shared with `apps/core/src/modules/marketing/storage.ts`
  as a convention, not as code** (a core module and an app cannot import from each other). Change one, change
  the other, and update both READMEs.
- Serve only the store codes in `FEEDS_STORE_CODES`; production refuses to start without it. Never list a
  directory. Refuse malformed paths, never sanitise them. One 404 body for every miss.
- No runtime dependencies. If something here needs a framework, it is doing too much.

## Gotchas

- The artifact root must be the same `FEEDS_DIR` the core publishes into; the core also needs
  `FEEDS_PUBLIC_URL` set to this app's public base URL, because that is what lands in `product_feed.url`.
- `infra/ci/check-image-manifests.sh` fails until window 5's Dockerfile lists `apps/feeds/package.json` in every
  image's `deps` stage. That is the intended prompt for the REQUEST, not a regression.
