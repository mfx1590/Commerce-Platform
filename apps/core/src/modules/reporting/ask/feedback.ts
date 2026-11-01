// The thumbs up/down on a BI Q&A answer (#606, `askMetricsFeedback`, contract #668). Only the asker may rate: the
// conversation must be theirs (in production: an `ai_call_audit` row with that conversation_id and actor_id), else a
// 404 — never a 403, so conversation ids are not confirmed. No free text (it could carry personal data). Append-only:
// a later rating supersedes the earlier one (the newest row per conversation and actor is the rating).
// The Postgres store (`ai_qa_feedback`, packages/db, the manager's landing on #606) replaces the memory one here when
// that table exists; until then production answers 503 (routes.ts).

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
