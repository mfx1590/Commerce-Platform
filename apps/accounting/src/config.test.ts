// The process configuration (#594): the consumer group defaults to the ledger group and can be renamed for a fresh
// read of the topics (Integration 4: `accounting.ledger.int4`), by flag or env, validated like
// consumer_processed.group_id.
import { describe, expect, it } from 'vitest';
import { DEFAULT_GROUP_ID, resolveConfig } from './config.js';
import { LEDGER_GROUP } from './consumer.js';

describe('resolveConfig: the consumer group', () => {
  it('defaults to the ledger group', () => {
    expect(DEFAULT_GROUP_ID).toBe(LEDGER_GROUP);
    expect(resolveConfig({}, []).groupId).toBe('accounting.ledger');
    expect(resolveConfig({ ACCOUNTING_GROUP_ID: '' }, ['--once']).groupId).toBe(
      'accounting.ledger',
    );
  });

  it('takes ACCOUNTING_GROUP_ID, and --group wins over it in both spellings', () => {
    expect(resolveConfig({ ACCOUNTING_GROUP_ID: 'accounting.ledger.int4' }, []).groupId).toBe(
      'accounting.ledger.int4',
    );
    const env = { ACCOUNTING_GROUP_ID: 'accounting.ledger.env' };
    expect(resolveConfig(env, ['--once', '--group', 'accounting.ledger.int4']).groupId).toBe(
      'accounting.ledger.int4',
    );
    expect(resolveConfig(env, ['--group=accounting.ledger.int4', '--once']).groupId).toBe(
      'accounting.ledger.int4',
    );
  });

  it('refuses a group consumer_processed would refuse', () => {
    for (const bad of ['Accounting.Ledger', '4accounting', 'accounting ledger', ''])
      expect(() => resolveConfig({}, ['--group', bad])).toThrow(/consumer group must match/);
    expect(() => resolveConfig({}, ['--group'])).toThrow(/consumer group must match/);
  });
});
