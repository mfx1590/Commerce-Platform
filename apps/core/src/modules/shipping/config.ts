// Per-store carrier credentials and settings (ADR 0006). Credentials come from environment variables only: locally
// from the repo-root `.env`, in a deployed environment from `<env>/stores/<store_code>/<provider>` in Secrets
// Manager, delivered as env by External Secrets. Nothing here is ever logged, embedded in an error or returned in
// a response — only the *name* of the variable that supplied a value.
import type { CarrierProviderName, LabelFormat, Parcel, StoreCarrierConfig } from './types';

export interface CarrierCredentials {
  apiKey: string;
  /** Which variable supplied it (for logs: names only, never values). */
  source: 'store' | 'global';
  /** The variable's name, so a misconfiguration can be reported without the value. */
  variable: string;
}

/** `brand-a` → `BRAND_A` (env variable suffix), the same rule window 9 uses for Algolia. */
export function envSuffix(storeCode: string): string {
  return storeCode.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * `EASYPOST_API_KEY_<CODE>` for the store, else the global `EASYPOST_API_KEY`; null when neither is set (the
 * caller then runs the `manual` provider). Test-mode keys start with `EZTK`; live keys (`EZAK`) are refused
 * outside production so a stray live key in a developer's `.env` cannot buy a real label.
 */
export function easyPostCredentialsFor(
  storeCode: string,
  env: NodeJS.ProcessEnv = process.env,
): CarrierCredentials | null {
  const storeVariable = `EASYPOST_API_KEY_${envSuffix(storeCode)}`;
  const storeKey = env[storeVariable];
  if (storeKey) return { apiKey: storeKey, source: 'store', variable: storeVariable };
  const globalKey = env.EASYPOST_API_KEY;
  if (globalKey) return { apiKey: globalKey, source: 'global', variable: 'EASYPOST_API_KEY' };
  return null;
}

/**
 * The tracking-webhook signing secret for a store: `EASYPOST_WEBHOOK_SECRET_<CODE>` (brand-a →
 * `EASYPOST_WEBHOOK_SECRET_BRAND_A`), else the global `EASYPOST_WEBHOOK_SECRET`; null when neither is set, and the
 * router then refuses the delivery before reading it. Deployed: `<env>/stores/<store_code>/easypost` (ADR 0006).
 * Never logged; the router reports only the variable NAME that is missing.
 */
export function easyPostWebhookSecretFor(
  storeCode: string,
  env: NodeJS.ProcessEnv = process.env,
): { secret: string; variable: string } | null {
  const storeVariable = `EASYPOST_WEBHOOK_SECRET_${envSuffix(storeCode)}`;
  const storeSecret = env[storeVariable];
  if (storeSecret) return { secret: storeSecret, variable: storeVariable };
  if (env.EASYPOST_WEBHOOK_SECRET) {
    return { secret: env.EASYPOST_WEBHOOK_SECRET, variable: 'EASYPOST_WEBHOOK_SECRET' };
  }
  return null;
}

/** True for an EasyPost **test**-mode key. Phase 2 buys labels in test mode only (issue #129). */
export function isTestModeKey(apiKey: string): boolean {
  return apiKey.startsWith('EZTK');
}

export const DEFAULT_PARCEL: Parcel = { lengthCm: 30, widthCm: 20, heightCm: 10, weightG: 1000 };

const LABEL_FORMATS: readonly LabelFormat[] = ['pdf', 'png', 'zpl'];

/**
 * Reads `store.settings.shipping` into a `StoreCarrierConfig`. Unknown or malformed fields fall back to the
 * defaults rather than throwing: a store whose settings a human mistyped still checks out with manual rates.
 *
 * ```jsonc
 * "shipping": {
 *   "provider": "easypost",
 *   "carrier_account_ids": ["ca_123"],
 *   "services": ["UPSGround"],
 *   "default_parcel": { "length_cm": 30, "width_cm": 20, "height_cm": 10, "weight_g": 1000 },
 *   "label_format": "pdf"
 * }
 * ```
 */
export function carrierConfigFor(storeSettings: unknown): StoreCarrierConfig {
  const shipping = record(record(storeSettings)?.shipping);
  return {
    provider: (stringOf(shipping?.provider) ?? 'manual') as CarrierProviderName,
    carrierAccountIds: stringArray(shipping?.carrier_account_ids),
    services: stringArray(shipping?.services),
    defaultParcel: parcelOf(shipping?.default_parcel) ?? DEFAULT_PARCEL,
    labelFormat: labelFormatOf(shipping?.label_format) ?? 'pdf',
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.trim());
}

function labelFormatOf(value: unknown): LabelFormat | null {
  const s = stringOf(value)?.toLowerCase();
  return s && (LABEL_FORMATS as readonly string[]).includes(s) ? (s as LabelFormat) : null;
}

function parcelOf(value: unknown): Parcel | null {
  const p = record(value);
  if (!p) return null;
  const length = positiveInt(p.length_cm);
  const width = positiveInt(p.width_cm);
  const height = positiveInt(p.height_cm);
  const weight = positiveInt(p.weight_g);
  if (length === null || width === null || height === null || weight === null) return null;
  return { lengthCm: length, widthCm: width, heightCm: height, weightG: weight };
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
