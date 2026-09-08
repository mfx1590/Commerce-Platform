// Payment providers of the checkout: the `manual` provider (authorises immediately; local dev, tests, and any
// store without a PSP) and the process-wide registry window 7 fills with `stripe` (#127) at boot. Card data never
// reaches this process (hosted fields, ADR 0004): providers exchange ids and amounts only.
import { randomUUID } from 'node:crypto';
import type { PaymentProvider, PaymentProviderName } from './types';

/** Authorises every amount at once; ids are `man_<uuid>` so they are recognisable in `payment` rows. */
export const manualPaymentProvider: PaymentProvider = {
  name: 'manual',
  async createSession() {
    return { sessionId: `man_${randomUUID()}`, clientSecret: null, status: 'pending' };
  },
  async authorize({ session }) {
    return { status: 'authorized', providerPaymentId: `manpay_${session.session_id}` };
  },
  async refund({ providerPaymentId }) {
    return { status: 'succeeded', providerRefundId: `manref_${providerPaymentId}` };
  },
};

const providers = new Map<PaymentProviderName, PaymentProvider>([
  ['manual', manualPaymentProvider],
]);

/** Registers (or replaces) a provider under its contract name. Returns the previous one so tests can restore it. */
export function setPaymentProvider(provider: PaymentProvider): PaymentProvider | undefined {
  const previous = providers.get(provider.name);
  providers.set(provider.name, provider);
  return previous;
}

/** The provider registered under `name`, or undefined (the route answers 400 `validation_error`). */
export function paymentProvider(name: string): PaymentProvider | undefined {
  return providers.get(name as PaymentProviderName);
}

export function registeredPaymentProviders(): PaymentProviderName[] {
  return [...providers.keys()];
}
