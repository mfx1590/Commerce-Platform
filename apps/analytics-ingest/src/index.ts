// Public API of @platform/analytics-ingest. Nothing outside this package may import from src/* directly.
export const PACKAGE_NAME = '@platform/analytics-ingest' as const;

export { createBatcher } from './batcher.js';
export type { Batcher, BatcherOptions, RowSink } from './batcher.js';
export {
  assertIdentifier,
  createChClient,
  createChReader,
  createRawEventsSink,
} from './clickhouse.js';
export type { ChClient } from './clickhouse.js';
export {
  DEFAULT_SQL_SOURCES,
  lintSqlFiles,
  LOCK_TTL_SECONDS,
  migrate,
  MigrationChangedError,
  MigrationLockedError,
  readSqlFiles,
  splitStatements,
} from './migrations.js';
export type { MigrateResult, SqlFile, SqlKind, SqlSource } from './migrations.js';
export { ConfigError, DEFAULT_GROUP, loadConfig } from './config.js';
export type { ClickHouseConfig, IngestConfig } from './config.js';
export { consoleLog, createIngest, processBatch, SimulatedCrash } from './ingest.js';
export type {
  BatchDeps,
  BatchResult,
  DeadLetterSink,
  Ingest,
  IngestLogLine,
  IngestOptions,
  IngestStats,
  Log,
} from './ingest.js';
export { createIngestMetrics } from './metrics.js';
export type { IngestMetrics } from './metrics.js';
export { idleState, waitForIdle } from './once.js';
export type { IdleOutcome, OnceReport, WaitForIdleOptions } from './once.js';
export {
  classify,
  InsertRejectedError,
  InvalidEventError,
  toClickHouseTime,
  UndecodableMessageError,
  UnknownEventError,
} from './rows.js';
export type { Classified, RawEventRow, WireBatch, WireMessage } from './rows.js';
