// The thumbs up/down on a BI Q&A answer (#606, `askMetricsFeedback`, contract #668). Only the asker may rate: the
// conversation must be theirs (in production: an `ai_call_audit` row with that conversation_id and actor_id), else a
// 404 — never a 403, so conversation ids are not confirmed. No free text (it could carry personal data). Append-only:
// a later rating supersedes the earlier one (the newest row per conversation and actor is the rating).
// The Postgres store (`ai_qa_feedback`, packages/db 0206) is production's; the memory one is for tests.
import type { ScopedClient } from '@platform/db';

export type Rating = 'up' | 'down';

export interface FeedbackKey {
  organizationId: string;
  conversationId: string;
  actorId: string;
}

export interface FeedbackStore {
  /** true when this actor asked this conversation (in this organization) */
  owns(key: FeedbackKey): Promise<boolean>;
  /** the Postgres store copies store_id from the conversation's audit rows (NULL for an organization question) */
  record(key: FeedbackKey & { rating: Rating }): Promise<void>;
}

export interface MemoryFeedbackStore extends FeedbackStore {
  readonly rows: ReadonlyArray<FeedbackKey & { rating: Rating; at: number }>;
  /** the rating that counts: the newest row for the conversation and actor */
  latest(key: FeedbackKey): Rating | undefined;
}

/** For tests: ownership comes from `asked` (in production, the audit rows). */
export function createMemoryFeedbackStore(
  asked: (key: FeedbackKey) => boolean,
): MemoryFeedbackStore {
  const rows: (FeedbackKey & { rating: Rating; at: number })[] = [];
  let clock = 0;
  const same = (a: FeedbackKey, b: FeedbackKey) =>
    a.organizationId === b.organizationId &&
    a.conversationId === b.conversationId &&
    a.actorId === b.actorId;
  return {
    rows,
    async owns(key) {
      return asked(key);
    },
    async record(row) {
      rows.push({ ...row, at: (clock += 1) });
    },
    latest(key) {
      return rows.filter((r) => same(r, key)).at(-1)?.rating;
    },
  };
}

/** The slice of the tenant client the Postgres store uses. */
export type FeedbackDb = Pick<ScopedClient, 'query'>;

const OWNED = `FROM ai_call_audit
  WHERE organization_id = $1 AND conversation_id = $2 AND actor_id = $3`;

/**
 * `ai_qa_feedback` (packages/db 0206), through the CALLER's tenant client: `store_nullable` RLS lets a store question's
 * audit rows (and its feedback) be seen by that store's principals, and an organization question's (store_id NULL) by
 * organization-level principals only — so a conversation outside the caller's reach simply does not exist for them.
 * The rating copies `store_id` from the conversation's own audit row, so its RLS scope is the question's.
 */
export function createPgFeedbackStore(db: FeedbackDb): FeedbackStore {
  return {
    async owns(key) {
      const r = await db.query(`SELECT 1 ${OWNED} LIMIT 1`, [
        key.organizationId,
        key.conversationId,
        key.actorId,
      ]);
      return r.rows.length > 0;
    },
    async record(row) {
      const r = await db.query(
        `INSERT INTO ai_qa_feedback (organization_id, store_id, conversation_id, actor_id, rating)
         SELECT $1, store_id, $2, $3, $4 ${OWNED} ORDER BY step NULLS FIRST LIMIT 1`,
        [row.organizationId, row.conversationId, row.actorId, row.rating],
      );
      if (r.rowCount !== 1)
        throw new Error('feedback: the conversation vanished between the check and the insert');
    },
  };
}
