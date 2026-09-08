// Process-wide registry of carrier providers, the same shape as the checkout module's payment registry: the
// `manual` provider is built in, everything else registers at boot. Task 2.2 resolves a store's provider by name
// from `carrierConfigFor(store.settings).provider`.
import { manualCarrierProvider } from './manual-provider';
import type { CarrierProvider, CarrierProviderName } from './types';

const providers = new Map<string, CarrierProvider>([['manual', manualCarrierProvider]]);

/** Registers (or replaces) a provider under its own name. Returns the previous one so tests can restore it. */
export function setCarrierProvider(provider: CarrierProvider): CarrierProvider | undefined {
  const previous = providers.get(provider.name);
  providers.set(provider.name, provider);
  return previous;
}

/** The provider registered under `name`, or undefined (the caller falls back to table rates). */
export function carrierProvider(name: string): CarrierProvider | undefined {
  return providers.get(name);
}

/** Never fails: an unknown or unconfigured provider name resolves to `manual`. */
export function carrierProviderOrManual(name: string | null | undefined): CarrierProvider {
  return (name ? providers.get(name) : undefined) ?? manualCarrierProvider;
}

export function registeredCarrierProviders(): CarrierProviderName[] {
  return [...providers.keys()];
}

/** Drops every provider but the built-in `manual` one. Tests only. */
export function resetCarrierProviders(): void {
  providers.clear();
  providers.set('manual', manualCarrierProvider);
}
