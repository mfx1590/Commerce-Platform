-- user: analytics_ro
-- password-env: CLICKHOUSE_READONLY_PASSWORD
--
-- #648 items 4 + 5: the read-only user of every query path (the metrics API, BI Q&A, recommendations) as SQL, so a
-- ClickHouse Cloud deploy (which ignores users.d) recreates it. The same limits the old users.d XML had (removed in #648), plus a
-- per-user bound: one tenant's parallel dashboards cannot take the memory or the query slots every other tenant's
-- metrics call needs (the metrics API answers 503 `unavailable` instead of the server falling over).
--   readonly = 1, 10 s, 100 000 result rows (throw), 512 MB per query          — as users.d
--   ≤ 16 queries at once and ≤ 768 MB together for this user                    — #648 item 4
--   ≤ 1200 queries a minute (the quota)                                         — #648 item 4
-- SELECT on {{database}}.* only: no system table (the server's select_from_system_db_requires_grant keeps the
-- writer's query text out of reach; README "Access"), no table function, no other database.
-- Where users.d still defines analytics_ro (no repo stack since #648), `ch:migrate` skips this file and says so.
CREATE SETTINGS PROFILE IF NOT EXISTS {{user}}_profile SETTINGS readonly = 1;
ALTER SETTINGS PROFILE {{user}}_profile SETTINGS readonly = 1, max_execution_time = 10, max_result_rows = 100000, result_overflow_mode = 'throw', max_memory_usage = 536870912, max_memory_usage_for_user = 805306368, max_concurrent_queries_for_user = 16;
CREATE USER IF NOT EXISTS {{user}} IDENTIFIED WITH sha256_hash BY '{{password_sha256}}' DEFAULT DATABASE {{database}};
ALTER USER {{user}} IDENTIFIED WITH sha256_hash BY '{{password_sha256}}' DEFAULT DATABASE {{database}} SETTINGS PROFILE '{{user}}_profile';
CREATE QUOTA IF NOT EXISTS {{user}}_quota FOR INTERVAL 1 minute MAX queries = 1200 TO {{user}};
ALTER QUOTA {{user}}_quota FOR INTERVAL 1 minute MAX queries = 1200 TO {{user}};
REVOKE ALL ON *.* FROM {{user}};
GRANT SELECT ON {{database}}.* TO {{user}};
