// Public API of @platform/analytics-ingest. Nothing outside this package may import from src/* directly.
export const PACKAGE_NAME = '@platform/analytics-ingest' as const;

export { createBatcher } from './batcher.js';
export type { Batcher, BatcherOptions, RowSink } from './batcher.js';
export {
  assertIdentifier,
  createChClient,
  createChReader,
  createRawEventsSink,
  DEFAULT_SQL_DIRS,
  migrate,
  MigrationChangedError,
  readSqlFiles,
  splitStatements,
} from './clickhouse.js';
export type { ChClient, MigrateResult, SqlFile } from './clickhouse.js';
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
  InvalidEventError,
  toClickHouseTime,
  UndecodableMessageError,
  UnknownEventError,
} from './rows.js';
export type { Classified, RawEventRow, WireBatch, WireMessage } from './rows.js';
