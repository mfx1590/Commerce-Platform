// Shape check for `store.settings` (#413). `settings` is free-form by contract (`additionalProperties: true`),
// but every key the core itself reads has a shape, and today each reader silently falls back to its default
// when a human mistypes one — a store that "has" `invoice_allowed: "yes"` quietly sells without invoices. This
// module names those keys once, so `onboardStore` and `updateStore` refuse a wrong shape with the contract's
// 422 `validation_error` (`details.settings` maps each offending path to what was expected) BEFORE it is stored.
//
// Rules: only keys listed here are checked; anything else is preserved untouched (other modules add keys
// without a registry change). A listed key is checked only when present (`undefined` = not given). The readers
// keep their forgiving fallbacks — this is the write-side gate, not a replacement. `payment.methods` is DERIVED
// (`GET /store` computes it from the Stripe key and `payment.invoice_allowed`) and is refused when written.
//
// Documented in README.md ("Store settings the core reads"); keep the two in step.
import { AppError } from '../../lib/errors';

/** path → expected shape (human-readable, goes into `details.settings`). */
export type SettingsProblems = Record<string, string>;

type Check = (value: unknown) => string | null; // the expectation when the value is wrong, null when fine

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const object: Check = (v) => (isRecord(v) ? null : 'object');
const boolean: Check = (v) => (typeof v === 'boolean' ? null : 'boolean');
const nonEmptyString: Check = (v) =>
  typeof v === 'string' && v.trim() !== '' ? null : 'non-empty string';
const stringOrNull: Check = (v) => (v === null || typeof v === 'string' ? null : 'string or null');
const nonNegativeInt: Check = (v) =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? null : 'integer >= 0';
const positiveInt: Check = (v) =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? null : 'integer >= 1';
const stringArray: Check = (v) =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : 'array of strings';
const oneOf =
  (...allowed: string[]): Check =>
  (v) =>
    typeof v === 'string' && allowed.includes(v) ? null : `one of ${allowed.join(', ')}`;
const arrayOf =
  (...allowed: string[]): Check =>
  (v) =>
    Array.isArray(v) && v.every((x) => typeof x === 'string' && allowed.includes(x))
      ? null
      : `array of ${allowed.join(' | ')}`;
/** `{ CC: warehouse code }` — the fulfilment routing override by destination country. */
const countryCodeMap: Check = (v) =>
  isRecord(v) &&
  Object.entries(v).every(
    ([country, code]) => /^[A-Za-z]{2}$/.test(country) && typeof code === 'string' && code !== '',
  )
    ? null
    : 'object of ISO-3166-1 alpha-2 country → warehouse code';
const derived: Check = () => 'derived by the server (never stored)';

/**
 * Every `store.settings` path the core reads, with its shape. Dotted paths; an intermediate object is checked
 * as `object` so a scalar where a group is expected is reported once, at the group, not at every leaf.
 */
export const STORE_SETTINGS_SHAPES: Readonly<Record<string, Check>> = {
  // payment (window 1, Store API `payment.methods`, #350 / #358)
  payment: object,
  'payment.invoice_allowed': boolean,
  'payment.methods': derived,
  // refunds (window 7, refund-router.ts): the ceiling for support's refunds; absent = no limit
  support_refund_limit_minor: nonNegativeInt,
  // fulfilment (window 8, fulfillment/registry.ts + routing.ts)
  fulfillment: object,
  'fulfillment.provider': nonEmptyString,
  'fulfillment.routing': object,
  'fulfillment.routing.default': stringOrNull,
  'fulfillment.routing.countries': countryCodeMap,
  // tax (window 7, tax/types.ts)
  tax: object,
  'tax.provider': oneOf('table', 'stripe'),
  'tax.prices_include_tax': boolean,
  'tax.shipping_taxable': boolean,
  // shipping (window 8, shipping/config.ts `carrierConfigFor`)
  shipping: object,
  'shipping.provider': nonEmptyString,
  'shipping.carrier_account_ids': stringArray,
  'shipping.services': stringArray,
  'shipping.default_parcel': object,
  'shipping.default_parcel.length_cm': positiveInt,
  'shipping.default_parcel.width_cm': positiveInt,
  'shipping.default_parcel.height_cm': positiveInt,
  'shipping.default_parcel.weight_g': positiveInt,
  'shipping.label_format': nonEmptyString,
  // fraud (window 7, fraud/types.ts `fraudSettingsFrom`)
  fraud: object,
  'fraud.providers': arrayOf('rules', 'radar'),
  'fraud.velocity': object,
  'fraud.velocity.max_orders': positiveInt,
  'fraud.velocity.window_minutes': positiveInt,
  'fraud.country_mismatch': oneOf('review', 'allow'),
  'fraud.radar_highest': oneOf('block', 'review'),
};

function valueAt(settings: Record<string, unknown>, path: string): unknown {
  let cur: unknown = settings;
  for (const part of path.split('.')) {
    if (!isRecord(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Collects every listed key whose value has the wrong shape. A group reported as wrong (`tax: 5`) hides its
 * leaves (`tax.provider` is undefined under a number and so is skipped). `undefined` is never a problem.
 */
export function settingsProblems(settings: unknown): SettingsProblems {
  const problems: SettingsProblems = {};
  if (settings === undefined) return problems;
  if (!isRecord(settings)) return { settings: 'object' };
  for (const [path, check] of Object.entries(STORE_SETTINGS_SHAPES)) {
    const value = valueAt(settings, path);
    if (value === undefined) continue;
    const expected = check(value);
    if (expected) problems[path] = expected;
  }
  return problems;
}

/**
 * Throws the contract's 422 `validation_error` (`details.settings`) when a listed key has the wrong shape.
 * The status is an explicit override: `validation_error` is 400 everywhere else (bad request shape); here the
 * body is well-formed JSON the contract allows, and it is the VALUE that cannot be processed (#413, #417).
 */
export function validateStoreSettings(settings: unknown): void {
  const problems = settingsProblems(settings);
  if (Object.keys(problems).length) {
    throw new AppError('validation_error', 'invalid store settings', { settings: problems }, 422);
  }
}
