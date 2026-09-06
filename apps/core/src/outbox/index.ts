// Public API of the outbox helper (ADR 0003). The only module allowed to write to the `outbox` table.
export {
  buildEvent,
  eventActor,
  InvalidEventError,
  withEvents,
  type BuildEventInput,
} from './with-events';
