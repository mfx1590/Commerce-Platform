# infra/load — the load test (#359)

The owner's target (2026-10-06): **30 orders per minute sustained for 10 minutes while browsing at 50 requests
per second; p95 under 500 ms** for `GET /store`, the product list and product detail; **errors under 0.1%**.

```bash
bash infra/load/run.sh                                        # target (10 min) + pool knee (~5.5 min) + placement ceiling (~6.5 min)
LOAD_SKIP_POOL=1 LOAD_SKIP_CEILING=1 bash infra/load/run.sh   # target run only
LOAD_SKIP_TARGET=1 bash infra/load/run.sh                     # the two ramps only (~12 min)
DURATION=1m BROWSE_RPS=5 ORDERS_PER_MIN=6 POOL_STEPS=20,40 POOL_STEP_S=20 CEILING_STEPS=6,12 CEILING_STEP=30s bash infra/load/run.sh   # smoke
```

On GitHub: **Actions → load (manual) → Run workflow** (`.github/workflows/load.yml`, `workflow_dispatch` only —
never on a pull request). It runs the same script on a GitHub-hosted runner and uploads `load-report`.

## What a run does

1. **A fresh core**, through `infra/ci/boot-smoke.sh` keep mode: database `platform_boot_smoke` created, migrated
   and seeded, Medusa's schema migrated, the core built and started on :9000. The shared `platform` database
   is never read or written; the run's database is dropped at the end, whatever happened.
2. **Stock** on that database only: `pnpm --filter @platform/db top-up-stock 600`, again before the ceiling run.
3. **Postgres sampled once a second** (`pg-sampler.mjs`) from `pg_stat_activity` for that database: connections
   by role and state, waits by event, lock waits. It connects over the network as the stack's admin role and
   only reads.
4. **k6**, the pinned `grafana/k6` image in Docker (the same binary on the laptop and on the runner):
   - `k6/load.js` — the target: `browse` at 50 req/s (GET /store 20%, list 40%, detail 30%, search 10%) and
     `place` at 30 orders/min (cart → line item → email + addresses → shipping options → shipping option →
     manual payment session → complete with an `Idempotency-Key`), both for 10 minutes;
   - `k6/pool.js` — `GET /store` only, 50 → 100 → 200 → 400 → 800 req/s, one minute each, requests tagged by
     step, to find where the app pool (`DB_POOL_MAX`, default 10; four connections per `GET /store`) saturates;
   - `k6/ceiling.js` — placement only on one store, 30 → 60 → … → 960 orders/min, one minute each, to find
     where the store-row lock stops it keeping up.
5. **`report.mjs`** → `report.md`: pass/fail per target line, p50/p95/p99 per route, orders/min achieved, error
   rate (split: what the core answered vs connections that never opened), the app pool's saturation, lock
   waits, the placement knee, and what Grafana would need. Self-tested in CI (`report.test.mjs`).

Every request is tagged with its `route`; the discovery requests k6 makes at setup are tagged `setup` and stay
out of every per-route number. Output lands in `infra/load/out/<timestamp>/` (git-ignored) unless a directory is
given; the reports worth keeping are committed under `reports/`.

## Needs

The compose stack's Postgres (127.0.0.1:5433), Redis (127.0.0.1:6381), Keycloak and OpenFGA up, and Docker for
the k6 image. `run.sh` never starts, stops or touches the stack's containers. Hosts are `127.0.0.1`, never
`localhost` (on Windows `localhost` resolves to `::1` first). On the laptop k6 reaches the core through
`host.docker.internal`; on Linux it uses `--network host`.

## Scheduled SLO regression (weekly, plan wave 3)

`.github/workflows/load.yml` also runs on a **schedule: Mondays 04:00 UTC**.

- **What runs:** the target run only (50 browse req/s + 30 orders/min, 10 min), on a fresh core and database on a
  GitHub runner. The two ramps are measurements, not gates, so they don't run on the schedule.
- **The gates are the SLOs.** `k6/slo-thresholds.js` is the one place k6 reads them, and
  `slo-thresholds.test.mjs` (CI's `changes` job) fails unless they equal `infra/observability/rules/slo.mjs`:

  | SLO                                           | k6 gate                                                                                                    |
  | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
  | store-api-latency                             | p95 < 500 ms on GET /store, product list, product detail                                                   |
  | checkout-latency                              | p95 < 2 s on `complete`; a **lower bound**: the run uses the `manual` payment provider, so no network call |
  | store-api-availability, checkout-availability | failed requests and failed placements < 0.1% (k6 also counts 4xx: stricter)                                |

  admin-metrics latency is not covered yet (#785: it needs ClickHouse and a staff token). The ingest and relay lag
  SLOs belong to the Prometheus rules, not to k6.

- **Retry once.** Runner noise is real, so when pass 1 crosses a gate, a second fresh pass runs, and only a second
  breach counts. When the retry fired, the summary says so ("the retry fired"): a flaky first pass is visible, not
  hidden. `slo-gate.mjs` is the judge (`slo-gate.test.mjs`).
- **Results:**
  - Every scheduled run comments on the tracking issue "load: weekly SLO regression tracking (scheduled k6)": the
    per-route p95 and failure rates against their gates, week by week.
  - A **confirmed** breach also opens, or comments on, ONE issue, "load regression (scheduled k6)", and fails the run.
  - Only the schedule writes issues, from a separate job holding `issues: write`. A manual run prints both texts in
    its job summary instead (a dry run). Nothing is committed to the repo.
  - The full reports and Postgres samples are in the run's artifact for 90 days.
- **Proving the breach path by hand:** run the workflow with `threshold_factor` below 1 (e.g. `0.05`). That scales the
  latency gates through `LOAD_THRESHOLD_FACTOR`, so both passes breach, and the summary shows the retry and the dry-run
  issue.

## Known limits

- **Laptop numbers are not a server's.** The core, Postgres, Redis and k6 share one machine; the report states
  the machine. The GitHub-runner run is a second datapoint, not production either.
- **On Windows, a few connections from k6's container never open** (`dial: i/o timeout`, status 0) — Docker
  Desktop's host forwarding, not the core. The report counts them apart from what the core answered.
- **The core's own metrics (#729) cover requests, not the pool.** With the observability profile up, Grafana's
  "Core per route" row shows the rate, the 5xx share and p95 per route and store during a run (the core's
  `http_server_request_duration_seconds` histogram and `core_http_requests_total` / `core_http_errors_total`). Waiting for
  a pool connection is still inferred, since Postgres cannot see a request queued for a connection. The 2026-10-06
  report predates #729.
