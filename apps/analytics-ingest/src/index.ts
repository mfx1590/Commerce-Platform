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
export {
  assertSingleReplica,
  consoleLog,
  createIngest,
  processBatch,
  SecondReplicaError,
  SimulatedCrash,
} from './ingest.js';
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
export {
  ApiReadError,
  createAdminReportsClient,
  createFinanceClient,
  inclusiveEnd,
} from './reconcile/clients.js';
export type {
  AdminReportsClient,
  ApiOptions,
  Fetch,
  FinanceClient,
  JournalLine,
} from './reconcile/clients.js';
export { addTo, compare, keyOf, listing } from './reconcile/diff.js';
export type { Difference, Figures, IdentityResult, Keyed } from './reconcile/diff.js';
export {
  assertWindow,
  checkBookings,
  checkCashLedger,
  checkCashReport,
  checkCopyIntegrity,
  checkLifetime,
  checkLineage,
  pullLedger,
} from './reconcile/identities.js';
export type { PulledLedger, ReconcileWindow } from './reconcile/identities.js';
export { reconcile, renderReport, SHOWN_DIFFERENCES } from './reconcile/run.js';
export type { ReconcileResult } from './reconcile/run.js';
export {
  applyErasure,
  createErasureIndex,
  erasedCustomerOf,
  ERASURE_SETTINGS,
  ErasureConfigError,
  IDENTIFIER_FIELDS,
  loadErasures,
  scrubAggregateId,
  scrubPayload,
} from './erasure.js';
export type {
  ApplyErasureDeps,
  ErasedCustomer,
  ErasureIndex,
  ErasureResult,
  IdentifierKind,
} from './erasure.js';
