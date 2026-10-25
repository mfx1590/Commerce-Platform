import { describe, expect, it } from 'vitest';
import { summariseDrain, waitForIdle, type DrainLogLine } from './drain.js';

/** A clock that only moves when the code under test sleeps: no real waiting, no flake. */
function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const ops = (event: DrainLogLine['event'], rule?: string): DrainLogLine =>
  ({ service: 'engagement', module: 'ops', event, ...(rule ? { rule } : {}) }) as DrainLogLine;

const cdp = (event: string, over: Record<string, unknown> = {}): DrainLogLine =>
  ({ service: 'engagement', module: 'cdp', event, ...over }) as DrainLogLine;

const crm = (event: string, over: Record<string, unknown> = {}): DrainLogLine =>
  ({ service: 'engagement', module: 'crm', event, ...over }) as DrainLogLine;

describe('summariseDrain', () => {
  it('counts per module, by event, by reason, by rule and by call', () => {
    const report = summariseDrain([
      ops('started'),
      ops('alert_sent', 'payment-failed'),
      ops('alert_sent', 'payment-failed'),
      ops('alert_suppressed', 'payment-failed'),
      cdp('started'),
      cdp('sent', { call: 'identify' }),
      cdp('sent', { call: 'track' }),
      cdp('dropped', { reason: 'no_identity' }),
      cdp('dropped', { reason: 'consent_revoked' }),
      cdp('skipped_unmapped', { topic: 'product.published' }),
      crm('upserted'),
      crm('skipped', { reason: 'no_consent' }),
      crm('stopped'),
    ]);

    expect(report.ops.handled).toBe(3);
    expect(report.ops.events).toEqual({ started: 1, alert_sent: 2, alert_suppressed: 1 });
    expect(report.ops.rules).toEqual({ 'payment-failed': 3 });

    expect(report.cdp.handled).toBe(5);
    expect(report.cdp.calls).toEqual({ identify: 1, track: 1 });
    expect(report.cdp.reasons).toEqual({ no_identity: 1, consent_revoked: 1 });

    expect(report.crm.handled).toBe(2);
    expect(report.crm.reasons).toEqual({ no_consent: 1 });
  });

  it('counts a CALL only when it was sent, never when the event was dropped', () => {
    // A dropped line carries the call the mapper produced before the gate refused it. Counting those would
    // report calls the adapter never received — found on the first real run (#594), where 152 mapped calls
    // met 148 sends.
    const report = summariseDrain([
      cdp('sent', { call: 'track' }),
      cdp('dropped', { call: 'track', reason: 'no_identity' }),
      cdp('dropped', { call: 'identify', reason: 'consent_revoked' }),
    ]);
    expect(report.cdp.calls).toEqual({ track: 1 });
    expect(report.cdp.handled).toBe(3);
    expect(report.cdp.events).toEqual({ sent: 1, dropped: 2 });
  });

  it('never counts a lifecycle line as an event off the bus', () => {
    // `started` / `stopped` / `dlq_poll` are about the process. Counting them would inflate "handled" by
    // two per module and make a drained run look busier than it was.
    const report = summariseDrain([
      ops('started'),
      ops('stopped'),
      ops('dlq_poll'),
      cdp('started'),
      cdp('stopped'),
    ]);
    expect(report.ops.handled).toBe(0);
    expect(report.cdp.handled).toBe(0);
    expect(report.ops.events).toEqual({ started: 1, stopped: 1, dlq_poll: 1 });
  });

  it('is empty for no lines at all, rather than undefined', () => {
    const report = summariseDrain([]);
    expect(report).toEqual({
      ops: { handled: 0, events: {}, reasons: {}, rules: {} },
      cdp: { handled: 0, events: {}, reasons: {}, calls: {} },
      crm: { handled: 0, events: {}, reasons: {} },
    });
  });
});

describe('waitForIdle', () => {
  it('reports EMPTY when no batch ever arrives, and not before the minimum run', async () => {
    const c = clock();
    const stop = await waitForIdle({
      lastBatchAt: () => null,
      startedAt: 0,
      idleMs: 1_000,
      minRunMs: 5_000,
      tickMs: 100,
      now: c.now,
      sleep: c.sleep,
    });
    expect(stop).toBe('empty');
    // The minimum matters: a fresh group has to join and be assigned partitions first, so "nothing yet" and
    // "nothing left" are indistinguishable until it has elapsed.
    expect(c.now()).toBeGreaterThanOrEqual(5_000);
  });

  it('reports IDLE once the bus has been quiet for the idle window after a batch', async () => {
    const c = clock();
    const stop = await waitForIdle({
      lastBatchAt: () => 3_000,
      startedAt: 0,
      idleMs: 1_000,
      minRunMs: 5_000,
      tickMs: 100,
      now: c.now,
      sleep: c.sleep,
    });
    expect(stop).toBe('idle');
  });

  it('waits while batches keep arriving, and reports MAX_RUN rather than hanging', async () => {
    const c = clock();
    const stop = await waitForIdle({
      // A batch every tick: never idle.
      lastBatchAt: () => c.now(),
      startedAt: 0,
      idleMs: 1_000,
      minRunMs: 5_000,
      maxRunMs: 10_000,
      tickMs: 100,
      now: c.now,
      sleep: c.sleep,
    });
    // A run that cannot stop is a result to report, never one to swallow: the ceiling exists so a
    // measurement window cannot be held open by a busy topic.
    expect(stop).toBe('max_run');
    expect(c.now()).toBeGreaterThanOrEqual(10_000);
  });
});
