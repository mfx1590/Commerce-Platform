// ClickHouse access: the writer and reader clients and the raw_events sink. The schema runner is migrations.ts.
import { createClient } from '@clickhouse/client';
import type { RowSink } from './batcher.js';
import type { ClickHouseConfig } from './config.js';
import type { RawEventRow } from './rows.js';

/** The slice of @clickhouse/client the ingest uses (a fake implements it in the tests). */
/** Server-side parameters (`{name:Type}` in the text): a value passed this way never appears in the query text. */
export type QueryParams = Record<string, unknown>;
/** Per-statement settings (the writer only: a readonly user is refused any). */
export type QuerySettings = Record<string, string | number>;

export interface ChClient {
  command(p: {
    query: string;
    query_params?: QueryParams;
    clickhouse_settings?: QuerySettings;
  }): Promise<unknown>;
  query(p: {
    query: string;
    format: 'JSONEachRow';
    query_params?: QueryParams;
    clickhouse_settings?: QuerySettings;
    /** Parameters (and the SQL) in the multipart BODY, not the URL: identifiers never reach an access log. */
    use_multipart_params?: boolean;
  }): Promise<{ json<T>(): Promise<T[]> }>;
  insert(p: {
    table: string;
    values: readonly unknown[];
    format: 'JSONEachRow';
    clickhouse_settings?: QuerySettings;
  }): Promise<unknown>;
  close(): Promise<void>;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

export function assertIdentifier(name: string): string {
  if (!IDENT.test(name)) throw new Error(`invalid ClickHouse identifier "${name}"`);
  return name;
}

/** The WRITER (ingest, migrator): pins the insert settings the offset commit relies on. */
export function createChClient(cfg: ClickHouseConfig, database = cfg.database): ChClient {
  return createClient({
    url: cfg.url,
    username: cfg.username,
    password: cfg.password,
    database: assertIdentifier(database),
    request_timeout: 30_000,
    // the insert's response is the acknowledgement the offset commit waits for: no async insert
    clickhouse_settings: { async_insert: 0, date_time_input_format: 'best_effort' },
  }) as unknown as ChClient;
}

/**
 * A READER (`analytics_ro`, readonly = 1): sends no per-query settings, because a readonly user is refused any
 * ("Cannot modify … in readonly mode"). Reads only; the metrics API (#603) builds on it.
 */
export function createChReader(
  cfg: Pick<ClickHouseConfig, 'url' | 'database'> & { username: string; password: string },
): ChClient {
  return createClient({
    url: cfg.url,
    username: cfg.username,
    password: cfg.password,
    database: assertIdentifier(cfg.database),
    request_timeout: 30_000,
  }) as unknown as ChClient;
}

export function createRawEventsSink(client: ChClient, table = 'raw_events'): RowSink<RawEventRow> {
  assertIdentifier(table);
  return {
    async insert(rows) {
      await client.insert({ table, values: rows, format: 'JSONEachRow' });
    },
  };
}
