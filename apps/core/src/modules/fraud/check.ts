// The fraud check (task 2.5, #128): runs the store's providers in order BEFORE authorization and returns the
// worst decision (`block` > `review` > `allow`).
//
// **A provider outage is `review` — never block, never a silent pass** (manager decision 2026-09-19). Fraud
// scoring is advisory risk: an outage that stopped all checkout would be a self-inflicted incident, and one that
// waved everything through would be an open door. So the order is placed, held for a human, and the outage is
// made visible: one log line (store id, provider, error class — no payload) and `fraud_provider_outages_total`.
// (Tax fails closed instead because a wrong tax is a money error; this is not.)
//
// **`block` answers like any decline** — the checkout turns it into 402 `payment_failed` with the generic
// message, no fraud-specific code, ever: a distinct answer would be an oracle for someone probing the rules. The
// true reason is recorded internally: an `audit_log` row written in its OWN transaction (the placement
// transaction rolls back on a block, and the record must survive it) — cart id, amounts, reason code, provider.
import type { ScopedClient } from '@platform/db';
import { writeAudit } from '../../lib/audit';
import { tenantClient } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { fraudMetrics } from './metrics';
import { createRadarFraudProvider, type RadarProviderOptions } from './radar-provider';
import { rulesFraudProvider } from './rules-provider';
import type { FraudCheck } from './seam';
import {
  ALLOW,
  fraudSettingsFrom,
  worse,
  type FraudContext,
  type FraudDecision,
  type FraudProvider,
  type FraudProviderName,
} from './types';

export interface FraudCheckOptions extends RadarProviderOptions {
  /** One line per outage / failed block record (ids and codes only). Default `console.warn`. */
  log?: (line: string) => void;
  /** Client for the block record's own transaction; default a tenant client of the store (src/lib/db). */
  recordClient?: (ctx: FraudContext) => ScopedClient;
  /** Replace the provider set (tests). */
  providers?: Partial<Record<FraudProviderName, FraudProvider>>;
}

export function createFraudCheck(opts: FraudCheckOptions = {}): FraudCheck {
  const log = opts.log ?? ((line: string) => console.warn(line));
  const providers: Record<FraudProviderName, FraudProvider> = {
    rules: opts.providers?.rules ?? rulesFraudProvider,
    radar: opts.providers?.radar ?? createRadarFraudProvider(opts),
  };

  async function recordBlock(ctx: FraudContext, decision: FraudDecision): Promise<void> {
    try {
      const client =
        opts.recordClient?.(ctx) ??
        tenantClient({ organizationId: ctx.organizationId, storeIds: [ctx.storeId] });
      await client.transaction((tx) =>
        writeAudit(tx, {
          organizationId: ctx.organizationId,
          storeId: ctx.storeId,
          actor: ctx.actor,
          action: 'fraud.block',
          entityType: 'cart',
          entityId: ctx.cartId,
          after: {
            outcome: 'block',
            reason_code: decision.reasonCode,
            provider: decision.provider,
            amount_minor: ctx.amountMinor,
            currency: ctx.currency,
            payment_provider: ctx.paymentProvider,
          },
        }),
      );
    } catch (err) {
      // The record is best effort; the DECISION stands either way.
      log(
        `[fraud] could not record block for cart ${ctx.cartId} (${decision.reasonCode}): ${(err as Error).name}`,
      );
    }
  }

  return {
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
      if (decision.outcome === 'block') await recordBlock(ctx, decision);
      return decision;
    },
  };
}
