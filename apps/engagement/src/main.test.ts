// The wiring, not the consuming: that every group a consumer RUNS is a group the DLQ watch WATCHES (#599).
//
// The bug this file exists for: `--drain` passed `config.groups` to the consumers and the long-running path
// built them inline without a group id, while `config.dlq.groups` had started defaulting to `config.groups`.
// So `ENGAGEMENT_CDP_GROUP_ID` without `--drain` moved the watch and left the consumer where it was — the
// process consumed `engagement.cdp` and reported "all clear" about `dlq.engagement.cdp.int4`, a queue nobody
// was filling. Expressed as the invariant below, main's old wiring fails these tests.
//
// No broker and no database: constructing a consumer connects to nothing, which is what makes the invariant
// cheap enough to assert on every combination that matters.

import { describe, expect, it } from 'vitest';
import type { ScopedClient } from '@platform/db';
import { resolveConfig, type EngagementConfig } from './config.js';
import { buildConsumers, buildTransport } from './main.js';
import { createStoreCodes } from './ops/store-codes.js';

const base = {
  DATABASE_URL_APP: 'postgres://platform_app:platform_app@127.0.0.1:5433/platform',
};

/** Enough of a client to construct with: nothing here is called until a consumer starts. */
const hq = {
  context: { organizationId: '00000000-0000-4000-8000-000000000001' },
  query: async () => ({ rows: [], rowCount: 0 }),
} as unknown as ScopedClient;

const pool = {} as never;

function consumersFor(env: Record<string, string>, argv: readonly string[] = []) {
  const config = resolveConfig({ env: { ...base, ...env }, argv });
  const set = buildConsumers({
    config,
    hq: hq as never,
    pool,
    transport: buildTransport(config),
    storeCodes: createStoreCodes(hq),
    log: () => undefined,
    ...(argv.includes('--drain') ? { fromBeginning: true } : {}),
  });
  return { config, set };
}

/** The running groups, as the consumers themselves report them. */
function running(set: ReturnType<typeof consumersFor>['set']): string[] {
  return [
    set.ops.groupId,
    ...(set.cdp ? [set.cdp.groupId] : []),
    ...(set.crm ? [set.crm.groupId] : []),
  ];
}

function expectWatchCoversRunning(
  config: EngagementConfig,
  set: ReturnType<typeof consumersFor>['set'],
) {
  for (const group of running(set)) expect(config.dlq.groups).toContain(group);
}

describe('every group a consumer runs is watched (#599)', () => {
  // #646: with the CRM enabled a principal is an explicit choice, so these fixtures name one.
  const all = {
    ENGAGEMENT_CDP_ENABLED: '1',
    ENGAGEMENT_CRM_ENABLED: '1',
    ENGAGEMENT_CRM_TOKEN_PROVIDER: 'mock',
  };

  it('holds with no overrides at all', () => {
    const { config, set } = consumersFor(all);
    expect(running(set)).toEqual(['engagement.ops', 'engagement.cdp', 'engagement.crm']);
    expectWatchCoversRunning(config, set);
  });

  it('holds when ONE consumer is overridden — the case that was broken', () => {
    // On the old wiring the consumer stayed on `engagement.cdp` while the watch moved to
    // `engagement.cdp.int4`: this assertion is the bug, stated.
    const { config, set } = consumersFor({
      ...all,
      ENGAGEMENT_CDP_GROUP_ID: 'engagement.cdp.int4',
    });
    expect(set.cdp?.groupId).toBe('engagement.cdp.int4');
    expect(running(set)).toEqual(['engagement.ops', 'engagement.cdp.int4', 'engagement.crm']);
    expectWatchCoversRunning(config, set);
  });

  it('holds for all three overridden, in the long-running mode (no --drain)', () => {
    // The mode must not decide this. The override is about WHICH group, never about which code path read it.
    const { config, set } = consumersFor({
      ...all,
      ENGAGEMENT_OPS_GROUP_ID: 'engagement.ops.int4',
      ENGAGEMENT_CDP_GROUP_ID: 'engagement.cdp.int4',
      ENGAGEMENT_CRM_GROUP_ID: 'engagement.crm.int4',
    });
    expect(running(set)).toEqual([
      'engagement.ops.int4',
      'engagement.cdp.int4',
      'engagement.crm.int4',
    ]);
    expectWatchCoversRunning(config, set);
  });

  it('holds in --drain too, with the same groups and the same watch', () => {
    const env = {
      ...all,
      ENGAGEMENT_OPS_GROUP_ID: 'engagement.ops.int4',
      ENGAGEMENT_CDP_GROUP_ID: 'engagement.cdp.int4',
      ENGAGEMENT_CRM_GROUP_ID: 'engagement.crm.int4',
    };
    const long = consumersFor(env);
    const drain = consumersFor(env, ['--drain']);
    // One builder, so the two modes cannot drift: the groups are identical and only `fromBeginning` differs.
    expect(running(drain.set)).toEqual(running(long.set));
    expectWatchCoversRunning(drain.config, drain.set);
  });

  it('holds when a module is OFF: its group is neither run nor required to be watched', () => {
    const { config, set } = consumersFor({ ENGAGEMENT_CDP_GROUP_ID: 'engagement.cdp.int4' });
    expect(set.cdp).toBeNull();
    expect(set.crm).toBeNull();
    expect(running(set)).toEqual(['engagement.ops']);
    expectWatchCoversRunning(config, set);
  });

  it('holds when the operator lists MORE groups than this process runs', () => {
    // Production must watch every group on the bus, other windows' included. More is fine; fewer is refused
    // in `resolveConfig` (tested there).
    const { config, set } = consumersFor({
      ...all,
      ENGAGEMENT_CDP_GROUP_ID: 'engagement.cdp.int4',
      ENGAGEMENT_DLQ_GROUPS:
        'engagement.ops, engagement.cdp.int4, engagement.crm, accounting.ledger, notifications.email',
    });
    expectWatchCoversRunning(config, set);
    expect(config.dlq.groups).toContain('accounting.ledger');
  });
});
