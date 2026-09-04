# @platform/db

Plain SQL migrations for every core entity (all rows carry store_id or organization_id), PostgreSQL row-level-security policies, the migration runner, the tenant-scoped client, and the seed loader. Tests prove that a session for store A cannot read rows of store B.

See CLAUDE.md for run/test commands and the public API. Owner: main window. Window 1 (core) may propose migrations via PR; main approves..
