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
} from './relay';
