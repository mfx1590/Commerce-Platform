// `--once` (the gate mode, like engagement's drain): consume from the group's committed offsets (from the
// beginning for a fresh group), stop once the bus has been quiet, and report. The report's DLQ count reads
// `dlq.<groupId>` of the SAME group the ingest consumed (config.groupId, #599): an override moves both.

export interface WaitForIdleOptions {
  lastBatchAt: () => number | null;
  startedAt: number;
  idleMs: number;
  /** A fresh group needs time to join before anything arrives: "nothing yet" is not "nothing left". */
  minRunMs: number;
  maxRunMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

export type IdleOutcome = 'idle' | 'max_run';

/** The stopping rule, pure enough to test without a broker. */
export function idleState(
  o: Pick<WaitForIdleOptions, 'startedAt' | 'idleMs' | 'minRunMs' | 'maxRunMs'>,
  lastBatchAt: number | null,
  now: number,
): IdleOutcome | 'running' {
  if (now - o.startedAt >= o.maxRunMs) return 'max_run';
  if (now - o.startedAt < o.minRunMs) return 'running';
  const quietSince = lastBatchAt ?? o.startedAt;
  return now - quietSince >= o.idleMs ? 'idle' : 'running';
}

export async function waitForIdle(o: WaitForIdleOptions): Promise<IdleOutcome> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const s = idleState(o, o.lastBatchAt(), now());
    if (s !== 'running') return s;
    await sleep(o.pollMs ?? 250);
  }
}

export interface OnceReport {
  service: 'analytics-ingest';
  mode: 'once';
  group_id: string;
  dlq_topic: string;
  outcome: IdleOutcome;
  duration_ms: number;
  batches: number;
  rows: number;
  rows_by_topic: Record<string, number>;
  dead_lettered_this_run: number;
  /** Every record on `dlq_topic` (this run and earlier ones), read back after the stop. */
  dlq_records: number;
}
