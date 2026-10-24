// Public API of @platform/accounting. Nothing outside this package may import from src/* directly.
export const PACKAGE_NAME = '@platform/accounting' as const;

export { ACCOUNT, DEFAULT_CHART } from './chart.js';
export type { AccountCode, AccountType, ChartAccount } from './chart.js';
export {
  createLedgerConsumer,
  handleLedgerEvent,
  LEDGER_GROUP,
  LEDGER_RETRIES,
  PROCESSED_TABLE,
} from './consumer.js';
export type { HandledEvent, HandleOptions, LedgerConsumerDeps } from './consumer.js';
export { balanceByCurrency, ensureChart, insertJournalEntry, trialBalance } from './ledger.js';
export type { TrialBalanceRow } from './ledger.js';
export {
  isLedgerTopic,
  LEDGER_TOPICS,
  legalEntityIdOf,
  needsOrderProjection,
  orderIdOf,
  postEvent,
  postOrderCancelled,
  postOrderPlaced,
  postPaymentCaptured,
  postRefundIssued,
  postShipmentShipped,
} from './posting/index.js';
export type {
  Journal,
  JournalEntry,
  JournalLine,
  LedgerTopic,
  OrderProjection,
  OrderProjectionLine,
  PaymentProjection,
  PostingResult,
  ReferenceType,
  RefundProjection,
} from './posting/index.js';
export {
  deleteParkedEvents,
  loadOrderProjection,
  loadParkedEvents,
  parkEvent,
  saveOrderProjection,
  savePaymentProjection,
  saveRefundProjection,
} from './projection.js';
export type { ParkedEvent } from './projection.js';
export * from './errors.js';
export * from './reconcile/index.js';
export * from './erp/index.js';
export * from './api/index.js';
export { consoleLogger, silentLogger, errorClassOf } from './log.js';
export type { Logger, LogLine } from './log.js';
