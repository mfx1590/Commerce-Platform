// The outbox relay (issue #531, ADR 0003 item 2): the ONE process that moves outbox rows onto the bus.
//
// Each pass is one transaction on an organization-scoped client: an advisory lock on the organization (two relay
// instances never interleave one organization's rows), the oldest unpublished rows in `seq` order, one publisher
// send per topic (rows of one topic in seq order; the publisher keeps one request in flight, so per-partition
// order survives retries), then `published_at = now()` for every acknowledged row, `attempts + 1` plus the error
// CLASS for every other row, and commit. A crash after the send and before the commit leaves the rows
// unpublished, so the next pass sends them again: at-least-once, and every consumer dedupes on the `outbox_id`
// header. Nothing here deletes a row or touches the in-process consumers' claim tables (notification_delivery,
// customer_export, customer_erasure_claim): they read the outbox by their own cursors and never `published_at`.
//
// One JSON line per pass carries counts, ids and seconds — never a payload, never an error message.
import {
  createValidator,
  envelopeToMessage,
  outboxRowToEnvelope,
  type MessagePublisher,
  type OutboxRow,
  type RelayMessage,
  type Validator,
} from '@platform/events';
import type { Queryable, ScopedClient } from '@platform/db';

export const RELAY_PRODUCER = 'core-outbox-relay/1';
export const DEFAULT_BATCH_SIZE = 500;
export const DEFAULT_INTERVAL_MS = 1000;

/** What the relay needs: `send` resolves once the broker acknowledged every message (see @platform/events). */
export type RelayPublisher = Pick<MessagePublisher, 'send'>;

export interface RelayOptions {
  organizationId: string;
  /** Rows per pass. Default 500. */
  batchSize?: number;
  /** Tests only: published topic = prefix + row.topic, so a test never writes to the real topics. */
  topicPrefix?: string;
  /** Test seam, called after every send and before the rows are marked: throwing here simulates a crash. */
  onPublished?: (publishedIds: string[]) => Promise<void> | void;
  /** Where the per-pass line goes. Default: console.info as one JSON line. */
  log?: (line: RelayPassResult) => void;
  now?: () => Date;
}

export interface RelayPassResult {
  relay: 'outbox';
  organization_id: string;
  /** Rows read in this pass. */
  batch: number;
  published: number;
  /** Rows whose send was not acknowledged: attempts + 1, last_error = error class, retried next pass. */
  failed: number;
  /** Rows whose envelope no longer validates: never sent, attempts + 1, last_error = invalid_envelope. */
  invalid: number;
  failed_topics: string[];
  duration_ms: number;
  /** Unpublished rows of this organization after the pass (app.outbox_lag). */
  lag_rows: number;
  /** Age of the oldest unpublished row after the pass, null when none. */
  lag_oldest_seconds: number | null;
}

type Row = OutboxRow & { seq: string };

const SELECT_UNPUBLISHED = `
  SELECT id, organization_id, store_id, topic, version, aggregate_type, aggregate_id, payload, headers,
         occurred_at, seq::text AS seq
  FROM outbox
  WHERE published_at IS NULL
  ORDER BY seq
  LIMIT $1`;

let validator: Validator | undefined;
const getValidator = (): Validator => (validator ??= createValidator());

/** The error CLASS only (`KafkaJSNumberOfRetriesExceeded`, `KafkaJSProtocolError:NOT_LEADER_FOR_PARTITION`): never the message. */
export function errorClass(err: unknown): string {
  if (!(err instanceof Error)) return 'Error';
  const type = (err as Error & { type?: unknown }).type;
  return typeof type === 'string' && type ? `${err.name}:${type}` : err.name;
}

async function lagOf(
  q: Queryable,
  organizationId: string,
  now: Date,
): Promise<Pick<RelayPassResult, 'lag_rows' | 'lag_oldest_seconds'>> {
  const r = await q.query<{ rows: string; oldest: Date | null }>(
    `SELECT coalesce(sum(unpublished), 0)::text AS rows, min(oldest_occurred_at) AS oldest
     FROM app.outbox_lag() WHERE organization_id = $1`,
    [organizationId],
  );
  const row = r.rows[0];
  const oldest = row?.oldest ?? null;
  return {
    lag_rows: Number(row?.rows ?? 0),
    lag_oldest_seconds: oldest
      ? Math.max(0, Math.round((now.getTime() - new Date(oldest).getTime()) / 1000))
      : null,
  };
}

/**
 * One pass: lock, read, publish per topic in seq order, mark, commit. Returns the pass line (also logged).
 * Safe to call again at any time; a pass that reads nothing costs one short transaction.
 */
export async function relayOnce(
  client: ScopedClient,
  publisher: RelayPublisher,
  opts: RelayOptions,
): Promise<RelayPassResult> {
  const now = opts.now ?? (() => new Date());
  const started = now();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const prefix = opts.topicPrefix ?? '';
  const v = getValidator();

  const result = await client.transaction(async (tx): Promise<RelayPassResult> => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `outbox-relay:${opts.organizationId}`,
    ]);
    const rows = (await tx.query<Row>(SELECT_UNPUBLISHED, [batchSize])).rows;

    const byTopic = new Map<string, { ids: string[]; messages: RelayMessage[] }>();
    const invalid: string[] = [];
    for (const row of rows) {
      const envelope = outboxRowToEnvelope(row);
      if (!v.validateEnvelope(envelope).ok) {
        invalid.push(row.id);
        continue;
      }
      const group = byTopic.get(row.topic) ?? { ids: [], messages: [] };
      group.ids.push(row.id);
      group.messages.push(envelopeToMessage(envelope, RELAY_PRODUCER));
      byTopic.set(row.topic, group);
    }

    const published: string[] = [];
    const failed = new Map<string, string[]>(); // error class → ids
    const failedTopics: string[] = [];
    for (const [topic, group] of byTopic) {
      try {
        await publisher.send(`${prefix}${topic}`, group.messages);
        published.push(...group.ids);
      } catch (err) {
        const cls = errorClass(err);
        failed.set(cls, [...(failed.get(cls) ?? []), ...group.ids]);
        failedTopics.push(topic);
      }
    }

    await opts.onPublished?.(published);

    if (published.length > 0) {
      await tx.query(
        `UPDATE outbox SET published_at = $2, attempts = attempts + 1, last_error = NULL WHERE id = ANY($1::uuid[])`,
        [published, now()],
      );
    }
    for (const [cls, ids] of failed) {
      await tx.query(
        `UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = ANY($1::uuid[])`,
        [ids, cls],
      );
    }
    if (invalid.length > 0) {
      await tx.query(
        `UPDATE outbox SET attempts = attempts + 1, last_error = 'invalid_envelope' WHERE id = ANY($1::uuid[])`,
        [invalid],
      );
    }

    const lag = await lagOf(tx, opts.organizationId, now());
    return {
      relay: 'outbox',
      organization_id: opts.organizationId,
      batch: rows.length,
      published: published.length,
      failed: [...failed.values()].reduce((n, ids) => n + ids.length, 0),
      invalid: invalid.length,
      failed_topics: failedTopics,
      duration_ms: now().getTime() - started.getTime(),
      ...lag,
    };
  });

  (opts.log ?? ((line) => console.info(JSON.stringify(line))))(result);
  return result;
}

export interface RelayLoopOptions extends RelayOptions {
  /** Pause after a pass that read fewer rows than the batch size. Default 1000 ms. */
  intervalMs?: number;
  /** Stops after the current pass. */
  signal?: AbortSignal;
}

/** Runs passes until `signal` aborts: back to back while a pass fills the batch, every `intervalMs` otherwise. */
export async function runRelayLoop(
  client: ScopedClient,
  publisher: RelayPublisher,
  opts: RelayLoopOptions,
): Promise<{ passes: number; published: number; failed: number }> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const totals = { passes: 0, published: 0, failed: 0 };
  while (!opts.signal?.aborted) {
    const r = await relayOnce(client, publisher, opts);
    totals.passes += 1;
    totals.published += r.published;
    totals.failed += r.failed;
    if (r.batch < batchSize || r.failed > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, intervalMs);
        function done() {
          opts.signal?.removeEventListener('abort', done);
          clearTimeout(t);
          resolve();
        }
        opts.signal?.addEventListener('abort', done, { once: true });
      });
    }
  }
  return totals;
}
