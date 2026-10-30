// #658: a non-default consumer group on a ledger ANOTHER accounting group has filled is refused at boot (a typo in
// ACCOUNTING_GROUP_ID would otherwise re-read every topic into the same ledger, dead-letter the whole history and leave
// the real group unconsumed), unless the operator opts in. Its own throwaway database: the rows are set up step by step.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROCESSED_TABLE } from '../src/consumer.js';
import { assertGroupIsSafe } from '../src/group-guard.js';
import { createAccountingTestDatabase, type AccountingTestDatabase } from './helpers/db.js';

let t: AccountingTestDatabase;
let n = 0;
const processed = (group: string) =>
  t.hq.query(`INSERT INTO ${PROCESSED_TABLE} (group_id, outbox_id) VALUES ($1, $2)`, [
    group,
    `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  ]);

beforeAll(async () => {
  t = await createAccountingTestDatabase();
}, 180_000);

afterAll(async () => {
  await t?.drop();
});

describe('the consumer group guard (#658)', () => {
  it('a fresh production deploy: an EMPTY consumer_processed and the default group start with no flag', async () => {
    expect(await assertGroupIsSafe(t.hq, 'accounting.ledger', false)).toEqual({ other_groups: [] });
  });

  it('an empty ledger takes any group; other services’ groups do not count', async () => {
    expect(await assertGroupIsSafe(t.hq, 'accounting.ledger.int4', false)).toEqual({
      other_groups: [],
    });
    await processed('engagement.ops');
    await processed('crm.sync');
    expect(await assertGroupIsSafe(t.hq, 'accounting.ledger.int4', false)).toEqual({
      other_groups: [],
    });
  });

  it('a mistyped group on a ledger the real group filled is refused (AccountingGroupRefused, naming the group); the opt-in allows it; the default group is never refused', async () => {
    await processed('accounting.ledger');
    await processed('accounting.ledger');
    await expect(assertGroupIsSafe(t.hq, 'accounting.ledgr', false)).rejects.toMatchObject({
      name: 'AccountingGroupRefused',
      message: expect.stringContaining('"accounting.ledger" (2 events)'),
      otherGroups: [{ group_id: 'accounting.ledger', rows: 2 }],
    });
    expect(await assertGroupIsSafe(t.hq, 'accounting.ledgr', true)).toEqual({
      other_groups: [{ group_id: 'accounting.ledger', rows: 2 }],
    });
    expect(await assertGroupIsSafe(t.hq, 'accounting.ledger', false)).toEqual({ other_groups: [] });
  });

  it('a group resuming on its own rows is fine; another NON-default accounting group counts too', async () => {
    // only the default group's rows so far: a second non-default group is refused because of them
    await processed('accounting.ledger.int4');
    await expect(assertGroupIsSafe(t.hq, 'accounting.ledger.int5', false)).rejects.toMatchObject({
      name: 'AccountingGroupRefused',
      otherGroups: [
        { group_id: 'accounting.ledger', rows: 2 },
        { group_id: 'accounting.ledger.int4', rows: 1 },
      ],
    });
  });
});
