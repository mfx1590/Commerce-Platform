// Which fulfilment provider a store uses. `store.settings.fulfillment.provider` names it; the registry supplies
// it. The in-memory provider is registered by default so a local run and every test work with no configuration —
// and it is named `memory`, not something that sounds production-ready, because it forgets every job on restart.
import { createMemoryFulfillmentProvider } from './memory-provider';
import type { FulfillmentProvider } from './types';

export const DEFAULT_FULFILLMENT_PROVIDER = 'memory';

const providers = new Map<string, FulfillmentProvider>();

function registerDefault(): void {
  providers.set(DEFAULT_FULFILLMENT_PROVIDER, createMemoryFulfillmentProvider());
}
registerDefault();

/** Registers (or replaces) a provider under its name. Returns the previous one so tests can restore it. */
export function setFulfillmentProvider(
  provider: FulfillmentProvider,
): FulfillmentProvider | undefined {
  const previous = providers.get(provider.name);
  providers.set(provider.name, provider);
  return previous;
}

/** Drops every registration and restores the default in-memory provider. Tests only. */
export function resetFulfillmentProviders(): void {
  providers.clear();
  registerDefault();
}

export function fulfillmentProvider(name: string): FulfillmentProvider | undefined {
  return providers.get(name);
}

/**
 * The provider a store's settings name, falling back to the default when the setting is missing or names
 * nothing registered — a misconfigured store keeps fulfilling rather than failing every order.
 */
export function fulfillmentProviderFor(settings: unknown): FulfillmentProvider {
  const named =
    settings !== null && typeof settings === 'object'
      ? ((settings as Record<string, unknown>).fulfillment as Record<string, unknown> | undefined)
          ?.provider
      : undefined;
  const provider = typeof named === 'string' ? providers.get(named) : undefined;
  return provider ?? providers.get(DEFAULT_FULFILLMENT_PROVIDER)!;
}
