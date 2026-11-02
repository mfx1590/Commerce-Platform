-- 0101 outbox (topic, seq) index (#702). The outbox replay (apps/core/src/outbox/replay.ts) scans one topic in seq
-- order (WHERE topic = $1 AND published_at IS NOT NULL AND seq > $n ORDER BY seq LIMIT $m) and, since #629, reads
-- the erased customers from every customer.erased row before each replay. Without this index both are sequential
-- scans of the whole outbox, which grows with every event and is never pruned.
--
-- Plain CREATE INDEX: the packages/db runner applies each migration inside a transaction, where CONCURRENTLY is not
-- allowed. It holds a SHARE lock on outbox (writes wait) for as long as the build takes. On a database with a large
-- outbox, build it CONCURRENTLY by hand first (packages/events README, "The outbox's indexes"); IF NOT EXISTS then
-- makes this migration a no-op there.
CREATE INDEX IF NOT EXISTS outbox_topic_seq_idx ON outbox (topic, seq);
