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

## Known limits

- **Laptop numbers are not a server's.** The core, Postgres, Redis and k6 share one machine; the report states
  the machine. The GitHub-runner run is a second datapoint, not production either.
- **On Windows, a few connections from k6's container never open** (`dial: i/o timeout`, status 0) — Docker
  Desktop's host forwarding, not the core. The report counts them apart from what the core answered.
- **No OpenTelemetry yet**: the core exports nothing, so pool waiting inside the core is inferred (Postgres
  cannot see a request queued for a connection). The report lists what Grafana would need.
