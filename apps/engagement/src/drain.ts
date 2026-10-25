// The one-shot DRAIN mode (#594, Integration 4 step 3): read the real topics from the beginning under a
// fresh group, then stop once the bus has gone quiet, and report what each consumer did.
//
// It is deliberately NOT `--once`, which is the single DLQ poll this service has always had — renaming that
// would break `pnpm once` and every runbook line that uses it.
//
// Two pieces live here rather than in `main.ts`, because they are the parts worth testing without a broker:
//   * `summariseDrain` turns the log lines the consumers already emit into the report, so the counts come
//     from the same lines an operator would read rather than from a second set of counters;
//   * `waitForIdle` is the stopping rule, and the reason it needs a rule at all is that a FRESH group has to
//     join and be assigned partitions before anything can arrive. "Nothing yet" and "nothing left" look
//     identical for the first few seconds, so a run also has a minimum length.

import type { CdpLogLine } from './cdp/consumer.js';
import type { CrmLogLine } from './crm/consumer.js';
import type { EngagementLogLine } from './types.js';

export type DrainLogLine = EngagementLogLine | CdpLogLine | CrmLogLine;

export interface DrainModuleReport {
  /** Every event the handler was given — sent, dropped, skipped and duplicates alike. */
  handled: number;
  /** Counts by the log line's own `event`, so nothing is lost in translation. */
  events: Record<string, number>;
  /** Counts by reason, for the lines that carry one (CDP drops, CRM skips). */
  reasons: Record<string, number>;
}

export interface DrainReport {
  ops: DrainModuleReport & { rules: Record<string, number> };
  cdp: DrainModuleReport & { calls: Record<string, number> };
  crm: DrainModuleReport;
}

/** `started` / `stopped` / `dlq_poll` are lifecycle lines, not events off the bus. */
const LIFECYCLE = new Set(['started', 'stopped', 'dlq_poll']);

function bump(into: Record<string, number>, key: string | undefined): void {
  if (key === undefined) return;
  into[key] = (into[key] ?? 0) + 1;
}

export function summariseDrain(lines: readonly DrainLogLine[]): DrainReport {
  const blank = (): DrainModuleReport => ({ handled: 0, events: {}, reasons: {} });
  const report: DrainReport = {
    ops: { ...blank(), rules: {} },
    cdp: { ...blank(), calls: {} },
    crm: blank(),
  };

  for (const line of lines) {
    const target =
      line.module === 'ops' ? report.ops : line.module === 'cdp' ? report.cdp : report.crm;
    bump(target.events, line.event);
    if (LIFECYCLE.has(line.event)) continue;
    target.handled += 1;
    if ('reason' in line) bump(target.reasons, line.reason);
    if (line.module === 'ops' && 'rule' in line) bump(report.ops.rules, line.rule);
    // Only what was actually SENT. A dropped CDP line still carries the `call` the mapper produced, so
    // counting every line here would report 149 tracks when 148 calls reached the adapter — a report that
    // quietly overstates what left the process is worse than no report.
    if (line.module === 'cdp' && line.event === 'sent' && 'call' in line) {
      bump(report.cdp.calls, line.call);
    }
  }
  return report;
}

export interface WaitForIdleOptions {
  /** When the last batch arrived, or `null` while none has. */
  lastBatchAt: () => number | null;
  /** When the consumers were started. */
  startedAt: number;
  /** Quiet for this long after the last batch = drained. */
  idleMs: number;
  /** No run ends before this, so a slow group join is not mistaken for an empty bus. */
  minRunMs: number;
  /** A hard stop, so a run can never hang a measurement window. */
  maxRunMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  tickMs?: number;
}

export type DrainStop = 'idle' | 'empty' | 'max_run';

/**
 * Resolves when the bus has gone quiet: `idle` after a batch, `empty` if none ever arrived, `max_run` if the
 * run hit its ceiling (which is a result to report, never something to swallow).
 */
export async function waitForIdle(opts: WaitForIdleOptions): Promise<DrainStop> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tick = opts.tickMs ?? 250;
  const maxRunMs = opts.maxRunMs ?? 10 * 60 * 1000;

  for (;;) {
    const elapsed = now() - opts.startedAt;
    if (elapsed >= maxRunMs) return 'max_run';
    const last = opts.lastBatchAt();
    if (elapsed >= opts.minRunMs) {
      if (last === null) return 'empty';
      if (now() - last >= opts.idleMs) return 'idle';
    }
    await sleep(tick);
  }
}
