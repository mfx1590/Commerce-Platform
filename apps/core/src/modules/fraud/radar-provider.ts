// The `radar` fraud provider (task 2.5, #128): Stripe Radar's verdict on the payment the shopper just confirmed.
// With the Payment Element the intent is confirmed client-side BEFORE placement, so its latest charge already
// carries Radar's `outcome` when the checkout asks: `risk_level` (`normal` / `elevated` / `highest`) and `type`
// (`manual_review` when a Radar rule sent it to Stripe's review queue). One `retrievePaymentIntent` with
// `expand[]=latest_charge` through the payments module's client and the store's own key. Codes only come back;
// nothing is logged.
//
// Non-stripe payments and intents without a charge yet (server-side confirm happens after this check) are
// `allow` here — Radar still acts at confirmation, and a later `review.opened` webhook flags the order
// (./webhooks). Outages are THROWN: the fraud check turns a provider outage into `review` (./check).
import type { Queryable } from '@platform/db';
import {
  StripeClient,
  StripeError,
  stripeCredentialsFor,
  type StripeApi,
  type StripeCredentials,
} from '../payments';
import {
  ALLOW,
  type FraudContext,
  type FraudDecision,
  type FraudProvider,
  type FraudSettings,
} from './types';

export interface RadarProviderOptions {
  /** Injectable for tests; default a real StripeClient per credential set. */
  apiFactory?: (credentials: StripeCredentials) => StripeApi;
  env?: NodeJS.ProcessEnv;
}

async function storeCodeFor(tx: Queryable, storeId: string): Promise<string> {
  const r = await tx.query<{ code: string }>(`SELECT code FROM store WHERE id = $1`, [storeId]);
  const code = r.rows[0]?.code;
  if (!code) throw new Error(`store ${storeId} not found while resolving stripe credentials`);
  return code;
}

export function createRadarFraudProvider(opts: RadarProviderOptions = {}): FraudProvider {
  return {
    name: 'radar',
    async evaluate(ctx: FraudContext, settings: FraudSettings): Promise<FraudDecision> {
      if (ctx.paymentProvider !== 'stripe' || !ctx.providerSessionId?.startsWith('pi_'))
        return ALLOW;
      const code = await storeCodeFor(ctx.tx, ctx.storeId);
      // A store paying with stripe has a key (the session was created with it); if it vanished since, that is
      // a provider problem like any other → thrown → `review`.
      const credentials = stripeCredentialsFor(code, opts.env ?? process.env);
      const api = opts.apiFactory
        ? opts.apiFactory(credentials)
        : new StripeClient({ secretKey: credentials.secretKey });
      let intent;
      try {
        intent = await api.retrievePaymentIntent(ctx.providerSessionId, {
          expand: ['latest_charge'],
        });
      } catch (err) {
        // An intent Stripe does not know is not a fraud signal (authorize will fail it); anything else is an outage.
        if (err instanceof StripeError && err.definitive) return ALLOW;
        throw err;
      }
      const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
      const outcome = charge?.outcome;
      if (!outcome) return ALLOW;
      if (outcome.risk_level === 'highest') {
        return { outcome: settings.radarHighest, reasonCode: 'radar_highest', provider: 'radar' };
      }
      if (outcome.type === 'manual_review') {
        return { outcome: 'review', reasonCode: 'radar_manual_review', provider: 'radar' };
      }
      if (outcome.risk_level === 'elevated') {
        return { outcome: 'review', reasonCode: 'radar_elevated', provider: 'radar' };
      }
      return ALLOW;
    },
  };
}
