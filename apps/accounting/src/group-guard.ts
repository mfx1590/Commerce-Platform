// The consumer-group guard (#658). A non-default group (`ACCOUNTING_GROUP_ID` / `--group`) starts from the beginning
// of every topic into the SAME ledger. On a ledger another accounting group has already filled, every old event hits
// UNIQUE (source_event_id, account_code), retries and dead-letters, while the real group silently stops being consumed:
// a typo abandons the books. So the process refuses to start a non-default group when `consumer_processed` holds rows
// of ANOTHER accounting group, unless the operator opts in for a known-empty or throwaway ledger
// (`ACCOUNTING_ALLOW_NEW_GROUP=1` / `--allow-new-group`: Integration 4, a rebuild into a fresh database). The default
// group is never refused. The month-replay gate builds its consumers directly (prefixed groups, throwaway databases)
// and is not affected.
import type { Queryable } from '@platform/db';
import { DEFAULT_GROUP_ID } from './config.js';
import { PROCESSED_TABLE } from './consumer.js';

export class AccountingGroupRefusedError extends Error {
  constructor(
    message: string,
    readonly otherGroups: { group_id: string; rows: number }[],
  ) {
    super(message);
    this.name = 'AccountingGroupRefused';
  }
}

/** Resolves when `groupId` may consume into this ledger; throws AccountingGroupRefused otherwise. */
export async function assertGroupIsSafe(
  q: Queryable,
  groupId: string,
  allowNewGroup: boolean,
): Promise<{ other_groups: { group_id: string; rows: number }[] }> {
  if (groupId === DEFAULT_GROUP_ID) return { other_groups: [] };
  const r = await q.query<{ group_id: string; rows: string }>(
    `SELECT group_id, count(*)::text AS rows FROM ${PROCESSED_TABLE}
      WHERE group_id <> $1 AND (group_id = $2 OR group_id LIKE 'accounting.%')
      GROUP BY group_id ORDER BY group_id`,
    [groupId, DEFAULT_GROUP_ID],
  );
  const other = r.rows.map((x) => ({ group_id: x.group_id, rows: Number(x.rows) }));
  if (other.length > 0 && !allowNewGroup)
    throw new AccountingGroupRefusedError(
      `consumer group "${groupId}" would re-post a ledger that ${other
        .map((o) => `"${o.group_id}" (${o.rows} events)`)
        .join(
          ', ',
        )} already filled: a typo in ACCOUNTING_GROUP_ID? For a known-empty or throwaway ledger pass --allow-new-group (ACCOUNTING_ALLOW_NEW_GROUP=1).`,
      other,
    );
  return { other_groups: other };
}
