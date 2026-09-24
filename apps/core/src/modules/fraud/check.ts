// The fraud check (task 2.5, #128): runs the store's providers in order BEFORE authorization and returns the
// worst decision (`block` > `review` > `allow`). Registered with the CHECKOUT's seam (core #236).
//
// **A provider outage is `review` — never block, never a silent pass** (manager decision 2026-09-19). Fraud
// scoring is advisory risk: an outage that stopped all checkout would be a self-inflicted incident, and one that
// waved everything through would be an open door. So the order is placed, held for a human, and the outage is
// made visible: one log line (store id, provider, error class — no payload) and `fraud_provider_outages_total`.
// (Tax fails closed instead because a wrong tax is a money error; this is not.)
//
// **`block` answers like any decline** — the checkout turns it into 402 `payment_failed` with the generic
// message, no fraud-specific code, ever: a distinct answer would be an oracle for someone probing the rules. The
// true reason is recorded internally as an `audit_log` row (`fraud.block`: cart id, amounts, reason code,
// provider — no PII).
//
// **That record is written AFTER the placement transaction has rolled back — never inside it, and never on a
// second connection while it is open** (manager decision 2026-09-19). `evaluate()` runs inside the placement
// transaction and therefore WRITES NOTHING. The record is written by `recordBlocked()`, which the CHECKOUT calls
// from `completeCart`'s catch once its transaction has rejected and released its connection (core #253, REQUEST
// #241) — the check opts in with `recordsBlockedAfterRollback: true`, and that is the only way a block is
// recorded in production. (The earlier version opened a second pool connection from inside `evaluate()`: every
// blocked placement then held two connections, and a burst of blocks the size of the pool would have dead-locked
// it, each holding one connection and waiting for another.)
//
// `deferredRecord: true` keeps the pre-#253 interim for a caller without the hook: `evaluate()` remembers the
// blocked placement and schedules its own flush with `setImmediate`, and the check does NOT set the marker (so a
// block is never recorded twice). The flush runs once the current call stack has unwound — which does NOT mean
// the placement's ROLLBACK has completed; what does hold is that the placement never awaits the flush, so it can
// never wait on the second connection: at worst the two overlap for a moment, and one record is written at a
// time. It is off by default and never used by the boot wiring.
//
// Writing the record is best effort; the DECISION stands either way.
import type { ScopedClient } from '@platform/db';
import { writeAudit, type Actor } from '../../lib/audit';
import { tenantClient } from '../../lib/db';
import { AppError } from '../../lib/errors';
import type { FraudCheck } from '../checkout';
import { fraudMetrics } from './metrics';
import { createRadarFraudProvider, type RadarProviderOptions } from './radar-provider';
import { rulesFraudProvider } from './rules-provider';
import {
  ALLOW,
  fraudSettingsFrom,
  worse,
  type FraudContext,
  type FraudDecision,
  type FraudProvider,
  type FraudProviderName,
} from './types';

/** What the block record needs — facts and codes only, and NO transaction handle. */
export interface BlockedPlacement {
  organizationId: string;
  storeId: string;
  cartId: string;
  amountMinor: number;
  currency: string;
  paymentProvider: string;
  actor: Actor;
  decision: FraudDecision;
}

export interface FraudCheckOptions extends RadarProviderOptions {
  /** One line per outage / failed block record (ids and codes only). Default `console.warn`. */
  log?: (line: string) => void;
  /** Client for the block record's own transaction; default a tenant client of the store (src/lib/db). */
  recordClient?: (blocked: BlockedPlacement) => ScopedClient;
  /** Replace the provider set (tests). */
  providers?: Partial<Record<FraudProviderName, FraudProvider>>;
  /**
   * `true` = the pre-#253 interim: `evaluate()` remembers each block and flushes it itself, and the check does
   * NOT set `recordsBlockedAfterRollback`. Default `false`: the checkout's post-rollback hook is the only caller
   * of `recordBlocked`, `evaluate()` remembers nothing. Never `true` in the boot wiring.
   */
  deferredRecord?: boolean;
}

/** The registered check plus the block record the checkout writes after the rollback. */
export interface ModuleFraudCheck extends FraudCheck {
  evaluate(ctx: FraudContext): Promise<FraudDecision>;
  /** `true` unless `deferredRecord` is on: the checkout calls `recordBlocked` after its rollback (#253). */
  recordsBlockedAfterRollback: boolean;
  /** Writes the `fraud.block` audit row in its own transaction. Call it AFTER the placement transaction ended. */
  recordBlocked(blocked: BlockedPlacement): Promise<void>;
  /** Interim only: writes every block remembered by `evaluate()` and not recorded yet; resolves when written. */
  flushBlockRecords(): Promise<void>;
  /** Interim only: blocks remembered and not yet WRITTEN — queued plus the batch a flush is writing right now. */
  pendingBlockRecords(): number;
}

export function createFraudCheck(opts: FraudCheckOptions = {}): ModuleFraudCheck {
  const log = opts.log ?? ((line: string) => console.warn(line));
  const deferred = opts.deferredRecord === true;
  const providers: Record<FraudProviderName, FraudProvider> = {
    rules: opts.providers?.rules ?? rulesFraudProvider,
    radar: opts.providers?.radar ?? createRadarFraudProvider(opts),
  };
  let pending: BlockedPlacement[] = [];
  let inFlight = 0; // taken off `pending` by a flush, not written yet
  let flushing: Promise<void> | null = null;

  async function recordBlocked(blocked: BlockedPlacement): Promise<void> {
    try {
      const client =
        opts.recordClient?.(blocked) ??
        tenantClient({ organizationId: blocked.organizationId, storeIds: [blocked.storeId] });
      await client.transaction((tx) =>
        writeAudit(tx, {
          organizationId: blocked.organizationId,
          storeId: blocked.storeId,
          actor: blocked.actor,
          action: 'fraud.block',
          entityType: 'cart',
          entityId: blocked.cartId,
          after: {
            outcome: 'block',
            reason_code: blocked.decision.reasonCode,
            provider: blocked.decision.provider,
            amount_minor: blocked.amountMinor,
            currency: blocked.currency,
            payment_provider: blocked.paymentProvider,
          },
        }),
      );
    } catch (err) {
      log(
        `[fraud] could not record block for cart ${blocked.cartId} (${blocked.decision.reasonCode}): ${(err as Error).name}`,
      );
    }
  }

  function flushBlockRecords(): Promise<void> {
    flushing = (flushing ?? Promise.resolve()).then(async () => {
      const batch = pending;
      pending = [];
      inFlight += batch.length;
      for (const blocked of batch) {
        await recordBlocked(blocked); // one connection at a time, never a burst; never throws
        inFlight -= 1;
      }
    });
    return flushing;
  }

  return {
    recordsBlockedAfterRollback: !deferred,
    recordBlocked,
    flushBlockRecords,
    pendingBlockRecords: () => pending.length + inFlight,

    async evaluate(ctx: FraudContext): Promise<FraudDecision> {
      const s = await ctx.tx.query<{ settings: unknown }>(
        `SELECT settings FROM store WHERE id = $1`,
        [ctx.storeId],
      );
      const settings = fraudSettingsFrom(s.rows[0]?.settings);
      let decision: FraudDecision = ALLOW;
      for (const name of settings.providers) {
        let next: FraudDecision;
        try {
          next = await providers[name].evaluate(ctx, settings);
        } catch (err) {
          if (err instanceof AppError) throw err; // a contract error of ours (404 …) is not an outage
          fraudMetrics.outage(name);
          log(
            `[fraud] provider ${name} unavailable for store ${ctx.storeId}: ${(err as Error).name}; order goes to review`,
          );
          next = { outcome: 'review', reasonCode: 'provider_unavailable', provider: name };
        }
        decision = worse(decision, next);
        if (decision.outcome === 'block') break;
      }
      fraudMetrics.evaluation(decision.outcome, decision.reasonCode);
      // NOTHING is written here: we are inside the placement transaction, which is about to roll back. The
      // checkout calls `recordBlocked` with these facts after that (#253); only the interim remembers them.
      if (decision.outcome === 'block' && deferred) {
        pending.push({
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          cartId: ctx.cartId,
          amountMinor: ctx.amountMinor,
          currency: ctx.currency,
          paymentProvider: ctx.paymentProvider,
          actor: ctx.actor,
          decision,
        });
        // Once the current call stack has unwound; not awaited by the placement (see the header).
        setImmediate(() => void flushBlockRecords());
      }
      return decision;
    },
  };
}
