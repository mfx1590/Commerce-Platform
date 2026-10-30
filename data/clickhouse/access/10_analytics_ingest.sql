-- user: analytics_ingest
-- password-env: CLICKHOUSE_INGEST_PASSWORD
--
-- #648 item 1: the long-running ingest's writer, least privilege. It inserts raw events (the MV pushes into
-- orders_minute_events), records erasures, and reads what the erasure path reads; the erasure's lightweight DELETE
-- and partition OPTIMIZE touch raw_events only. A lightweight DELETE is a write of the hidden `_row_exists` column:
-- ClickHouse (25.8) checks ALTER UPDATE on that one column, so the grant is that column only, never ALTER UPDATE
-- on the data. No DDL, no access management, nothing outside {{database}}: the
-- schema is the migrator's (the admin user), never this one's.
-- Applied by `ch:migrate` on every run (server-level, idempotent): the password is set from the env as a sha256 hash
-- computed at run time (never in git), and the grants are reset to exactly these.
CREATE USER IF NOT EXISTS {{user}} IDENTIFIED WITH sha256_hash BY '{{password_sha256}}' DEFAULT DATABASE {{database}};
ALTER USER {{user}} IDENTIFIED WITH sha256_hash BY '{{password_sha256}}' DEFAULT DATABASE {{database}};
REVOKE ALL ON *.* FROM {{user}};
GRANT SELECT, INSERT ON {{database}}.* TO {{user}};
GRANT ALTER DELETE, ALTER UPDATE(_row_exists), OPTIMIZE ON {{database}}.raw_events TO {{user}};
