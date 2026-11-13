/**
 * Store payment settings (#825): "Pay on invoice" is `settings.payment.invoice_allowed`. Pure — no
 * React, no `next/*`.
 *
 * `updateStore` REPLACES the whole `settings` object, and other modules keep their own keys there
 * (tax, fraud, shipping, fulfillment, content, refund limits — apps/core/src/modules/registry/README.md),
 * so a change is a read-modify-write of the store as the core has it now, never of what the page
 * loaded. `payment.methods` is DERIVED (the Store API computes it) and the core refuses it when
 * written, so it is never sent even if a stored object somehow carries it.
 */

import type { AdminError } from '../api/admin-client';

type Settings = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the Payment section shows; the only settings value that reaches the browser. */
export interface PaymentSettingsView {
  invoice_allowed: boolean;
}

/** `settings.payment.invoice_allowed`, read safely: anything but `true` is off. */
export function paymentSettingsFrom(settings: unknown): PaymentSettingsView {
  const payment = isRecord(settings) ? settings['payment'] : undefined;
  return { invoice_allowed: isRecord(payment) && payment['invoice_allowed'] === true };
}

/**
 * The full settings object to send: every key of `current` kept as it is, `payment` merged with the
 * new `invoice_allowed`, and the derived `payment.methods` dropped.
 */
export function withInvoiceAllowed(
  current: unknown,
  invoiceAllowed: boolean,
): Record<string, unknown> {
  const base: Record<string, unknown> = isRecord(current) ? { ...current } : {};
  const payment: Record<string, unknown> = isRecord(base['payment']) ? { ...base['payment'] } : {};
  delete payment['methods'];
  payment['invoice_allowed'] = invoiceAllowed;
  base['payment'] = payment;
  return base;
}

/**
 * The core's 422 on settings names each offending path (`details.settings`), e.g.
 * `{ 'payment.invoice_allowed': 'boolean' }`. Said in words, every path listed.
 */
export function describeSettingsError(failure: { status: number; error: AdminError }): string {
  const details = failure.error.details as Settings | undefined;
  const settings = details?.['settings'];
  if (failure.status === 422 && isRecord(settings) && Object.keys(settings).length > 0) {
    const problems = Object.entries(settings)
      .map(([path, expected]) => `${path} must be ${String(expected)}`)
      .join('; ');
    return `The store's settings were refused: ${problems}. Nothing was saved.`;
  }
  return failure.error.message;
}
