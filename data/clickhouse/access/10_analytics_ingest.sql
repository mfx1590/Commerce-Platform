-- user: analytics_ingest
-- password-env: CLICKHOUSE_INGEST_PASSWORD
--
-- #648 item 1: the long-running ingest's writer, least privilege. It inserts raw events, records erasures, and reads
-- what the erasure path reads; the erasure's lightweight DELETE and partition OPTIMIZE touch raw_events only. A
-- lightweight DELETE is a write of the hidden `_row_exists` column: ClickHouse (25.8) checks ALTER UPDATE on that one
-- column, so the grant is that column only, never ALTER UPDATE on the data. No DDL, no access management, nothing
-- outside {{database}}: the schema is the migrator's (the admin user), never this one's.
-- INSERT only into the tables it writes (#648 follow-up): raw_events, customer_erasures, and every materialised
-- view's TO table that an insert into raw_events pushes to (today mv_orders_minute → orders_minute_events). A new MV
-- on raw_events needs its TO table here: access.test.ts derives that list from the migrations and fails otherwise.
-- Never a mart, ledger_lines (the reconcile job's, as the admin) or _migrations.
-- Applied by `ch:migrate` on every run (server-level, idempotent): the password is set from the env as a sha256 hash
-- computed at run time (never in git), and the grants are reset to exactly these.
CREATE USER IF NOT EXISTS {{user}} IDENTIFIED WITH sha256_hash BY '{{password_sha256}}' DEFAULT DATABASE {{database}};
ALTER USER {{user}} IDENTIFIED WITH sha256_hash BY '{{password_sha256}}' DEFAULT DATABASE {{database}};
REVOKE ALL ON *.* FROM {{user}};
GRANT SELECT ON {{database}}.* TO {{user}};
GRANT INSERT ON {{database}}.raw_events TO {{user}};
GRANT INSERT ON {{database}}.customer_erasures TO {{user}};
GRANT INSERT ON {{database}}.orders_minute_events TO {{user}};
GRANT ALTER DELETE, ALTER UPDATE(_row_exists), OPTIMIZE ON {{database}}.raw_events TO {{user}};
