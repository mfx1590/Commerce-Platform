// The insert buffer shared by every partition the process consumes. `add(rows)` resolves only once the insert
// that carried those rows was ACKNOWLEDGED by ClickHouse (and rejects if it failed), so the caller commits its
// Kafka offsets after the ack and never before. A flush happens when `batchSize` rows are waiting, or `flushMs`
// after the first row of the current buffer arrived, whichever comes first.

export interface RowSink<R> {
  insert(rows: readonly R[]): Promise<void>;
}

export interface BatcherOptions<R> {
  sink: RowSink<R>;
  batchSize: number;
  flushMs: number;
  /** Called after each acknowledged insert (metrics, `--once` progress). */
  onFlushed?: (rows: readonly R[], durationMs: number) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
}

export interface Batcher<R> {
  add(rows: readonly R[]): Promise<void>;
  /** Flushes whatever is buffered now (shutdown). */
  flush(): Promise<void>;
  readonly pending: number;
}

export function createBatcher<R>(opts: BatcherOptions<R>): Batcher<R> {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const now = opts.now ?? Date.now;
  let rows: R[] = [];
  let waiters: Waiter[] = [];
  let timer: unknown;
  /** Inserts run one after the other: ClickHouse sees the buffers in order, and a failure fails only its own. */
  let chain: Promise<void> = Promise.resolve();

  function flushNow(): Promise<void> {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
    if (rows.length === 0 && waiters.length === 0) return chain;
    const mine = rows;
    const mineWaiters = waiters;
    rows = [];
    waiters = [];
    const run = chain.then(async () => {
      const started = now();
      try {
        if (mine.length > 0) await opts.sink.insert(mine);
      } catch (err) {
        for (const w of mineWaiters) w.reject(err);
        return;
      }
      opts.onFlushed?.(mine, now() - started);
      for (const w of mineWaiters) w.resolve();
    });
    chain = run;
    return run;
  }

  return {
    get pending() {
      return rows.length;
    },
    add(batch) {
      return new Promise<void>((resolve, reject) => {
        rows.push(...batch);
        waiters.push({ resolve, reject });
        if (rows.length >= opts.batchSize) void flushNow();
        else if (timer === undefined) timer = setTimer(() => void flushNow(), opts.flushMs);
      });
    },
    flush: flushNow,
  };
}
