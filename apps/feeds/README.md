# @platform/feeds

Serves the published product feed files that Google Merchant Center and Meta Commerce fetch.

Owner: **window 17 (marketing)** · Issue #146 · Contracts: `contracts-v0.3`.

## What it is, and what it deliberately is not

This app **serves bytes**. It has no database connection, no catalogue access and no way to change anything —
which is what makes it safe to put on a public URL with a crawler hitting it every few hours.

Generation lives in the core's marketing module (`apps/core/src/modules/marketing`): `publishFeed` reads the
catalogue, validates every row against the channel's required fields, renders the file and stores it. The split
is forced — a core module cannot import from an app and an app cannot import from a core module — and it is the
right way round: the thing that needs the database stays behind the admin API, the thing on the public internet
does not have one.

```
POST /admin/stores/{id}/marketing/feeds/{feedId}/publish   (core)  →  renders + stores the artifact
GET  /feeds/{store_code}/{feedId}.xml                      (here)  →  hands it to the crawler
```

## The key convention (shared with the core)

    <store_code>/<feed_id>.<ext>          e.g.  brand-a/70000000-0000-4000-8000-000000000731.xml

This is the entire contract between the two processes: **a convention, not code**. Both sides validate it the
same way, and changing it means changing both — `apps/core/src/modules/marketing/storage.ts` and
`src/storage.ts` here. Extensions are `xml` (Google Merchant RSS) and `csv` (Meta).

## Routes

| Route                                  | Answer                                                  |
| -------------------------------------- | ------------------------------------------------------- |
| `GET /feeds/{store_code}/{feedId}.xml` | the Google Merchant RSS file, `application/xml`         |
| `GET /feeds/{store_code}/{feedId}.csv` | the Meta catalogue file, `text/csv`                     |
| `HEAD` on either                       | the same headers, no body (crawlers checking freshness) |
| `GET /health`                          | `200 {"status":"ok"}` — the container health check      |
| anything else                          | `404 {"code":"not_found"}`                              |

Responses carry `x-robots-tag: noindex` (a feed is not a page) and `cache-control: public, max-age=300`.

## Refusals are the interesting part

- **Only this instance's store codes.** `FEEDS_STORE_CODES` lists them; a request for any other code is a 404
  even when the file is sitting on the same disk. In production the server **refuses to start** without the
  variable rather than serving every code it happens to find — the same shape as the core's `CORE_DEV_TOKENS`
  guard.
- **Never lists.** There is no directory route. `/feeds/brand-a/`, `/feeds/`, `/` are all 404.
- **Refuses, does not sanitise.** `store_code`, `feed_id` and the extension are matched against patterns; a
  `..` segment or a non-uuid feed id is rejected outright, and the resolved path is checked to be under the
  root anyway.
- **One 404 body for everything.** "No such feed", "not published yet" and "not served here" are indistinguishable
  from outside, so a crawler cannot enumerate feed ids.
- **GET and HEAD only**; anything else is 405.

## Configuration

| Variable            | Default                        | Meaning                                                        |
| ------------------- | ------------------------------ | -------------------------------------------------------------- |
| `PORT`              | `4020`                         | listen port                                                    |
| `FEEDS_DIR`         | `.feeds`                       | artifact root; the same directory the core's publish writes to |
| `FEEDS_STORE_CODES` | — (**required** in production) | comma-separated store codes this instance serves               |
| `FEEDS_MAX_AGE`     | `300`                          | `cache-control` max-age in seconds                             |

The core needs `FEEDS_DIR` (the same path) and `FEEDS_PUBLIC_URL` (the base URL this app is reachable at, which
becomes `product_feed.url`).

## Run / test

```bash
pnpm --filter @platform/feeds dev        # tsx watch on src/main.ts
pnpm --filter @platform/feeds test       # vitest — no database, no docker stack, ~1 s
pnpm --filter @platform/feeds typecheck
```

To see a real feed end to end: publish one through the Admin API with `FEEDS_DIR` set on the core, then
`curl http://localhost:4020/feeds/brand-a/<feedId>.xml`.

## Storage

The default is the local filesystem, which is correct for development and for a single-node deployment. The
seam it sits behind (`FeedStorage` in the core) takes an S3-style implementation without touching the publish
job — window 5 provisions the bucket (requested with this task). This app then grows an S3 reader beside
`FeedReader`, with the same key convention and the same refusals.

## Not done yet

- **No Dockerfile.** `**/Dockerfile` is window 5's path; requested with the first PR of #146. Until it lands
  `infra/ci/check-image-manifests.sh` fails, because every image's `deps` stage must list
  `apps/feeds/package.json` — that failure is the intended prompt, not a regression.
- Feeds are rendered in memory by the publish job. Fine at Phase 2 volumes; streaming or a background job is a
  Phase 3 concern.
- `tiktok` and `pinterest` are legal feed channels in the contract but have no writer yet, so publishing one is
  a 409 rather than an empty file.
