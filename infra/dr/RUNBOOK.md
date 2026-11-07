# Backup and restore drill — runbook (#741, plan D5)

A backup nobody has restored is a guess. This drill makes it a measurement:

1. It backs up the state of the shared dev stack: Postgres, ClickHouse, Keycloak and OpenFGA.
2. It restores that backup into a **fresh** stack that shares nothing with the dev stack.
3. It checks that everything came back.
4. It records how long the restore took (RTO) and how much data a restore from that backup would lose (RPO).

One command does all of it, and it always removes the drill stack at the end, even when a check fails.

```bash
node infra/dr/drill.mjs all
```

## Before you start

- **Ask for the machine.** A run starts a second Postgres, ClickHouse (capped at 1.5 GB), Keycloak (~1 GB) and OpenFGA
  next to the dev stack for about two minutes. Coordinate with the manager, and don't run it during a k6 or Lighthouse
  measurement.
- **The shared stack is up**, including ClickHouse (`--profile analytics`). The drill reads it and never starts,
  stops or recreates it.
- **`pnpm install`** has run in this checkout. The drill uses `pg` from `packages/db` and runs `ch:migrate` from
  `apps/analytics-ingest`.
- **The repo-root `.env`** has `DATABASE_URL`, `OPENFGA_STORE_ID` and `OPENFGA_MODEL_ID`. If `OPENFGA_STORE_ID` is
  empty (OpenFGA lost its in-memory store after a Docker restart), run
  `pnpm --filter @platform/auth-sdk fga:seed` first. It only adds: it reuses the store and writes what is missing.
- **Ports 25433, 28123, 28180 and 28081 are free.** The drill refuses to start otherwise. It also refuses if a
  `commerce-dr` stack already exists.
- **Backups go outside git**, to `DR_BACKUP_DIR` (default `C:/Users/mehdi/Desktop/commerce-platform-backups`). Set it
  on another machine. A backup holds dev data and the roles' password hashes: never commit one.

## Running it

| Command                                   | What it does                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `node infra/dr/drill.mjs all`             | backup, then restore + check (timed), then teardown. **The drill.**                   |
| `node infra/dr/drill.mjs backup`          | the backup only; prints its folder `dr-<UTC stamp>`                                   |
| `node infra/dr/drill.mjs restore [<dir>]` | restore + check the newest backup (or `<dir>`), then teardown                         |
| `… restore --keep`                        | leave the drill stack up afterwards to look around (ports above), then:               |
| `node infra/dr/drill.mjs teardown`        | `docker compose -p commerce-dr down -v`: removes the drill containers **and** volumes |

The run prints one line per stage and ends with `CHECKS GREEN` (exit 0) or `CHECKS FAILED (n)` followed by every
mismatch (exit 1). Two files land in the backup folder: `manifest.json` (what the backup holds) and
`report-<stamp>.json` (what the restore showed, the timings and every failure).

## What is backed up, and how

| Store      | Backup                                                                                                                                   | Restore                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Postgres   | `pg_dump -Fc` of `platform` **inside** the container, plus `pg_dumpall --roles-only`, both copied out with `docker cp` to a Windows path | roles, then `pg_restore --exit-on-error` into the fresh `platform` database                                 |
| ClickHouse | per table in `analytics`: `SHOW CREATE` + `SELECT * … FORMAT Native`                                                                     | tables + rows first, views next, **materialized views last**; then `ch:migrate` against the drill for users |
| Keycloak   | the partial export of `staff` and `customers` (clients, roles, groups) **plus the realm files' users**                                   | `--import-realm` on the drill Keycloak's first start                                                        |
| OpenFGA    | the authorization model and every tuple                                                                                                  | a new store, the model, the tuples                                                                          |

Why these choices:

- **Postgres is snapshot-consistent.** The drill opens a REPEATABLE READ transaction on the dev database, exports
  its snapshot, and runs `pg_dump --snapshot=<that>`. It then computes the expected numbers in the same transaction,
  so they are exactly what the dump holds even while other windows keep writing. The drill reads as the database
  owner, like `pg_dump` itself. It is DR tooling, not an app path, so it does not go through the tenant client.
- **ClickHouse is exported, not `BACKUP`ed.** `BACKUP … TO Disk` needs a backups disk in the server's config, which
  would mean changing and restarting the shared server. ClickHouse has no snapshot to hold, so the drill takes its
  numbers before and after the export and repeats the export if they moved. Materialized views are created after
  the rows are in, or the inserts would feed their target tables a second time.
- **ClickHouse users come from `data/clickhouse/access`**, as everywhere else. `_migrations` is restored with the
  data, so `ch:migrate` on the drill finds nothing to apply and only creates the users, with random passwords that
  live in memory for the run.
- **Keycloak: partial export plus the realm files' users (decision K2).** A partial export carries no users. A full
  export would mean starting a second Keycloak JVM inside the shared container, against the dev-file database every
  window's login depends on, and that risk is not worth taking. In production, Keycloak's own database is backed up
  instead (launch checklist below).
- **OpenFGA in compose is in memory**, so this export is its only backup.

## What it checks

Every number below is taken at backup time and compared, **exactly**, with the restored stack.

| Check                                  | How                                                                                                                                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rows per table                         | `count(*)` for all 217 tables, in both schemas (`public`, `medusa`)                                                                                                                                                                                       |
| Rows per store                         | `count(*) GROUP BY store_id` / `organization_id` for every table that has one (129 columns)                                                                                                                                                               |
| Content checksum ("the seed checksum") | `md5` of every row's text in a fixed order, per table. Same session settings both sides (UTC, ISO dates, `extra_float_digits = 3`)                                                                                                                        |
| Sequences, roles, RLS policies         | `pg_sequences.last_value` (not snapshot-bound: see the failure table), the role list, `count(*) FROM pg_policies`                                                                                                                                         |
| ClickHouse rows                        | `count() … FINAL` per table (a background merge must not change the number), plus `count()` of every view, which proves the models still work                                                                                                             |
| ClickHouse events per topic            | `uniqExact(event_id)` per `topic` in `raw_events`                                                                                                                                                                                                         |
| ClickHouse access                      | `analytics_ro` logs in and reads `raw_events`                                                                                                                                                                                                             |
| Keycloak                               | users, clients, realm roles and groups per realm                                                                                                                                                                                                          |
| OpenFGA                                | tuple count + digest                                                                                                                                                                                                                                      |
| **Staff login**                        | a password grant on the drill Keycloak as `store-admin` (client `test-cli`); the token's `sub` must be that user's id                                                                                                                                     |
| **Permission check**                   | the core's own path: `sub` → `staff_user.keycloak_subject` in the **restored** Postgres → `user:<staff_user.id>` in the restored OpenFGA. One check must be allowed (a tuple of that user's) and one denied (the same user and relation on another store) |

## Measured

Three runs of `node infra/dr/drill.mjs all`. All exited 0 with **CHECKS GREEN**, and each teardown left no
`commerce-dr` container or volume.

|                      | Run 1: window 5, 09:08Z                                                                                                                                                                       | Run 2: window 5, 09:15Z                                                                                         | **Run 3: the manager, 09:19Z (the independent hand)**       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Code                 | the first permission check (below)                                                                                                                                                            | the linked check, `01ecf774`                                                                                    | the linked check, `01ecf774`                                |
| Backup               | 44 s (Postgres dump 1.6 MB; folder 2.9 MB)                                                                                                                                                    | 49 s                                                                                                            | 36 s                                                        |
| **RTO**              | **100 s** = stack up 58 + data 27 + checks 15                                                                                                                                                 | **109 s** = 60 + 35 + 14                                                                                        | **74 s** = 37 + 23 + 14                                     |
| **RPO (measured)**   | 150 739 s (~41.9 h)                                                                                                                                                                           | 151 192 s                                                                                                       | 151 386 s                                                   |
| Restored and matched | 217 tables / 25 995 rows / 129 tenant columns with checksums, 8 sequences, 4 roles, 71 policies; 5 ClickHouse tables (1 138 raw events across 21 topics), 24 views, 1 MV; 2 realms; 14 tuples | the same                                                                                                        | the same (217 tables / 25 995 rows / 21 topics / 14 tuples) |
| Staff login          | `store-admin` → `sub` `seed-store-admin`                                                                                                                                                      | the same                                                                                                        | the same                                                    |
| Permission check     | the first tuple in the store (`seed-owner` owner `organization:hq`) allowed; an unknown user denied                                                                                           | `sub` → restored `staff_user` `…044`: `store_admin store:…031` **allowed**, `store_admin store:…033` **denied** | the same as run 2                                           |

All three runs are 2026-11-07, on the same laptop and the same data: the newest restored row was Postgres
2026-11-05 15:16Z and ClickHouse 2026-11-02 18:45Z each time.

**The collision guard, proven by accident.** The manager's first attempt at 09:17Z started while run 2's drill stack
was still up. The drill refused before touching anything (`a commerce-dr stack already exists: run
node infra/dr/drill.mjs teardown first`), and run 2 finished untouched. Run 3 started after run 2's teardown.

What the numbers mean:

- **RTO** is the wall clock from `compose up` of the empty drill stack to every check green: 74–109 s here. Roughly
  40–60 s of it is the stack starting, mainly Keycloak, and depends on how busy the laptop is. The data itself
  restores in 23–35 s at dev scale. It grows with the data, so re-measure it on a production-sized copy before
  quoting it as a production RTO.
- **RPO as measured** is "how old is the newest thing we got back". On dev it mostly measures how long the stack
  has been idle: nothing was written for ~42 h, and nothing was lost. The **method's** RPO is the time between two
  backups: with a nightly `pg_dump`, up to 24 h. With RDS point-in-time recovery (launch checklist), about 5 minutes.
- **Run 1's permission check** proved OpenFGA came back, but not its link to the login: FGA users are
  `staff_user.id`, not the Keycloak `sub`. The linked check replaced it. Runs 2 and 3 are the evidence for it.
- After run 3 the Opus review added one fix that changes no check: the ClickHouse export's temp dir in the shared
  container is now removed on every path, a failure mid-export included.

To add a run, add a column with its `report-<stamp>.json` numbers.

## When it fails

The report lists every mismatch by path, e.g. `postgres.perTenant.public.orders.store_id.<id>: expected 12, got 11`.

| Symptom                                               | Cause / fix                                                                                                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a commerce-dr stack already exists`                  | an earlier run was interrupted: `node infra/dr/drill.mjs teardown`                                                                                                                      |
| `port 2xxxx … is in use`                              | something else holds it. Windows may have reserved it (`netsh interface ipv4 show excludedportrange protocol=tcp`)                                                                      |
| `OPENFGA_STORE_ID is not set` / OpenFGA 400 or 404    | run `pnpm --filter @platform/auth-sdk fga:seed`                                                                                                                                         |
| `expected one running container` for the shared stack | it is not up (ClickHouse needs `--profile analytics`). Ask before starting anything                                                                                                     |
| `clickhouse: the data kept moving`                    | the ingest is writing during the export. Retry when it is quiet                                                                                                                         |
| `postgres.sequences.<seq>: expected N, got M`         | a sequence's `last_value` is not bound to the snapshot, so a `nextval` elsewhere during the backup moves it. That is a false FAILURE, never a false pass. Rerun when the stack is quiet |
| A mismatch you want to inspect                        | `node infra/dr/drill.mjs restore <dir> --keep`, then connect to 25433 / 28123 / 28180 / 28081, then `teardown`                                                                          |

The backup folder stays after every run. Restoring an older one is `restore <dir>`.

## Safety: what the drill never does, and two traps it avoids

- It never starts, stops, recreates or writes the shared stack. It runs queries and exports, and writes two temp
  files in the shared Postgres and ClickHouse containers' `/tmp`, which it removes. The drill stack has its own
  project name (`commerce-dr`), its own `127.0.0.1` ports above 15000 and its own `dr-*` volumes.
  `drill.test.mjs` (in CI's `changes` job) fails if any of that ever overlaps the shared stack.
- **Trap 1: `infra/keycloak/reimport.mjs` deletes the realm by default.** Run without `--export`, it deletes and
  re-creates the realm on whatever Keycloak it points at. The drill therefore never spawns it: it calls the same
  partial-export endpoint itself.
- **Trap 2: `ch:migrate` falls back to the shared ClickHouse.** With `CLICKHOUSE_URL` unset it connects to
  `127.0.0.1:18123`, the dev server. The drill always passes the drill's URL and refuses to run it unless the URL
  ends in `:28123`.
- **`docker cp` gets a Windows path** (`C:/…`). The drill calls Docker with argument arrays, never through Git Bash,
  whose `/c/…` paths and `\` handling have broken a manual backup before.

## Restoring by hand

These are the same steps without the script, e.g. into a stack you brought up yourself. `<dir>` is a backup folder.

```bash
docker compose -p commerce-dr -f infra/dr/docker-compose.drill.yml up -d --wait   # with DR_KEYCLOAK_IMPORT=<dir>/keycloak
docker cp <dir>/postgres/roles.sql <pg-container>:/tmp/ && docker exec <pg-container> psql -U platform -d postgres -f /tmp/roles.sql
docker cp <dir>/postgres/platform.dump <pg-container>:/tmp/ && docker exec <pg-container> pg_restore -U platform -d platform --exit-on-error /tmp/platform.dump
# ClickHouse: run each <table>.sql in tables.json order (data tables first, then INSERT … FROM INFILE '<table>.native' FORMAT Native), then the views, then the MVs; then ch:migrate with CLICKHOUSE_URL pointing at the restored server
# OpenFGA: POST /stores, POST /stores/{id}/authorization-models with model.json, POST /stores/{id}/write with tuples.json in batches of 100
```

## Not covered (yet)

- **The core end to end** against the restored stack, i.e. a guarded Admin API call. The drill checks the same
  links one level down (login → `staff_user` → OpenFGA). Booting the core against the drill is a follow-up.
- **Redis, Redpanda, Odoo and the observability stores** are outside D5's scope (Postgres, ClickHouse, auth state).
  The outbox in Postgres is the bus's source of truth. Whether Redis or Redpanda need their own backup is a launch
  question (below).
- **Keycloak users** come from the realm files (K2), not from the live database.

## Launch checklist (cloud only: written, not built)

- [ ] **RDS:** automated backups with point-in-time recovery (retention ≥ 7 days), deletion protection, and a final
      snapshot on delete. Target RPO about 5 min.
- [ ] **A restore drill per quarter** into a fresh instance from PITR, with this runbook's checks. Record RTO/RPO
      here.
- [ ] **S3 for backups and exports:** versioning, encryption with KMS, a lifecycle (e.g. 30 days standard →
      infrequent access → expire at 1 year), and Object Lock if the retention must be tamper-proof. A separate
      account or bucket policy so the app's role cannot delete backups.
- [ ] **Keycloak** on the managed Postgres, backed up with it (replaces K2's realm-file users).
- [ ] **OpenFGA** on a Postgres datastore, not memory, backed up with it.
- [ ] **ClickHouse:** a backups disk / `BACKUP … TO S3` schedule (ClickHouse Cloud backs up automatically; check its
      retention).
- [ ] **Redis and the bus:** decide what is state and what is rebuildable. Set Redpanda Cloud retention so the
      ingest can replay at least the ClickHouse backup interval.
- [ ] **RTO/RPO targets** agreed with the owner, and the alert or drill that proves them.
