// Public API of the outbox helper (ADR 0003). The only module allowed to write to the `outbox` table.
export {
  buildEvent,
  eventActor,
  InvalidEventError,
  withEvents,
  type BuildEventInput,
} from './with-events';

// The relay (#531): reads unpublished rows in seq order and publishes them (apps/core/src/outbox/relay.ts).
export {
  relayOnce,
  runRelayLoop,
  type RelayOptions,
  type RelayPassResult,
  type RelayPublisher,
  type RelayLoopTotals,
  type RelayPassError,
  RelayPublishTimeout,
  guardPoolClients,
  type GuardablePool,
  type RelayConnectionError,
  DEFAULT_PUBLISH_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
} from './relay';

// Replay from the outbox (#534): apps/core/src/outbox/replay.ts, CLI `pnpm --filter @platform/core outbox:replay`.
// Erasure-aware since #629: the rows that name an erased customer are skipped (ERASURE_RULES).
export {
  describeReplay,
  ERASURE_RULES,
  HEADER_REPLAY,
  HEADER_REPLAYED_AT,
  loadErasedSet,
  namesErased,
  replayOutbox,
  type ErasedSet,
  type ReplayBatchLine,
  type ReplayOptions,
  type ReplaySummary,
} from './replay';
