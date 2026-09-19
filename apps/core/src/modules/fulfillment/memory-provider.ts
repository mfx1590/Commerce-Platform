// The in-memory 3PL: what every test and a local run use until a real provider is wired. It behaves like a real
// one in the ways that matter to the rest of the system — it accepts, it can be advanced through picking and
// packing, it refuses a cancel once picking has started, and it reports tracking when it ships — and it lets a
// test drive each of those states explicitly.
import { randomUUID } from 'node:crypto';
import { BoundedTtlMap } from '../shipping';
import {
  FulfillmentError,
  type CancelResult,
  type FulfillmentAck,
  type FulfillmentProvider,
  type FulfillmentRequest,
  type FulfillmentState,
  type FulfillmentUpdate,
} from './types';

interface Job {
  request: FulfillmentRequest;
  update: FulfillmentUpdate;
}

/** States from which a cancel is still free: nothing has been taken off a shelf yet. */
const CANCELLABLE: FulfillmentState[] = ['accepted'];

/** The order a real warehouse moves through; `advance` refuses to go backwards. */
const ORDER: FulfillmentState[] = ['accepted', 'picking', 'packed', 'shipped'];

export interface MemoryFulfillmentProvider extends FulfillmentProvider {
  /** Moves a job forward, as the warehouse would. `shipped` needs a tracking number. */
  advance(
    externalId: string,
    state: FulfillmentState,
    tracking?: { trackingNumber: string; trackingUrl?: string; carrier?: string },
  ): FulfillmentUpdate;
  /** Makes the next `push` throw, to exercise the compensating cancel. */
  failNextPush(reason?: string): void;
  /** Requests received, in order. Tests only. */
  requests(): FulfillmentRequest[];
}

export function createMemoryFulfillmentProvider(
  name = 'memory',
  options: { now?: () => Date; maxJobs?: number } = {},
): MemoryFulfillmentProvider {
  const now = options.now ?? (() => new Date());
  // Bounded like every other in-process index in these modules: a long-running process must not grow for ever.
  const jobs = new BoundedTtlMap<Job>({ maxEntries: options.maxJobs ?? 1000, ttlMs: Infinity });
  const received: FulfillmentRequest[] = [];
  let failure: string | null = null;

  const job = (externalId: string): Job => {
    const found = jobs.get(externalId);
    if (!found) throw new FulfillmentError(name, 'lookup', `unknown fulfilment ${externalId}`);
    return found;
  };

  return {
    name,
    async push(request): Promise<FulfillmentAck> {
      if (failure !== null) {
        const reason = failure;
        failure = null;
        throw new FulfillmentError(name, 'push', reason, true);
      }
      if (request.lines.length === 0) {
        throw new FulfillmentError(name, 'push', 'a fulfilment needs at least one line');
      }
      const externalId = `ful_${randomUUID()}`;
      received.push(request);
      jobs.set(externalId, {
        request,
        update: {
          externalId,
          reference: request.reference,
          state: 'accepted',
          trackingNumber: null,
          trackingUrl: null,
          carrier: request.carrier,
          occurredAt: now().toISOString(),
        },
      });
      return { externalId, state: 'accepted' };
    },
    async status(externalId): Promise<FulfillmentUpdate> {
      return { ...job(externalId).update };
    },
    async cancel(externalId): Promise<CancelResult> {
      const current = job(externalId);
      if (current.update.state === 'cancelled') return { cancelled: true };
      if (!CANCELLABLE.includes(current.update.state)) {
        return { cancelled: false, reason: `already ${current.update.state}` };
      }
      current.update = { ...current.update, state: 'cancelled', occurredAt: now().toISOString() };
      return { cancelled: true };
    },
    advance(externalId, state, tracking) {
      const current = job(externalId);
      const from = ORDER.indexOf(current.update.state);
      const to = ORDER.indexOf(state);
      if (from === -1 || to === -1 || to <= from) {
        throw new FulfillmentError(
          name,
          'advance',
          `cannot go from ${current.update.state} to ${state}`,
        );
      }
      if (state === 'shipped' && !tracking?.trackingNumber) {
        throw new FulfillmentError(name, 'advance', 'shipped needs a tracking number');
      }
      current.update = {
        ...current.update,
        state,
        trackingNumber: tracking?.trackingNumber ?? current.update.trackingNumber,
        trackingUrl: tracking?.trackingUrl ?? current.update.trackingUrl,
        carrier: tracking?.carrier ?? current.update.carrier,
        occurredAt: now().toISOString(),
      };
      return { ...current.update };
    },
    failNextPush(reason = 'provider unavailable') {
      failure = reason;
    },
    requests() {
      return [...received];
    },
  };
}
