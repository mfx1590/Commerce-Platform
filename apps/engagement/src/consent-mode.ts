// The per-store consent-mode ENV contract (#576) and the key validation #586 added.
//
// WHY THIS IS ITS OWN MODULE, and not part of `config.ts`: `config.ts` imports the three consumers for
// `KNOWN_GROUPS`, so a consumer cannot import `config.ts` back without a cycle — and `createCdpConsumer` is
// where the "does this override name a real store?" check belongs, because the store list only exists after
// the consumer has warmed its store codes. Both sides import this instead. It also puts the ONE normalisation
// rule in one place, which is the whole lesson of #586: the bug was a key stored raw and looked up
// normalised, and two copies of a transform are the same bug waiting to happen again.

import { ConfigRefusedError } from './config-error.js';
import type { ConsentMode } from './consent.js';

export const CONSENT_MODE_ENV = 'ENGAGEMENT_CDP_CONSENT_MODE';
export const CONSENT_MODE_ENV_PREFIX = `${CONSENT_MODE_ENV}_`;

/**
 * Every way the consent-mode configuration can be wrong, under one class (#590 review).
 *
 * It has a name of its own for one reason: the crash line prints the CLASS of an error and not its message,
 * because a message can carry a webhook URL, a write key or the row being handled. The messages THIS class
 * carries are built here, from env variable names and store codes only — no payload, no secret, no personal
 * data — so the entry point is allowed to print them, and the operator gets told which variable is wrong
 * instead of the word "Error".
 */
export class ConsentModeConfigError extends ConfigRefusedError {
  constructor(message: string) {
    super(message);
    this.name = 'ConsentModeConfigError';
  }
}

const MODES = new Set<ConsentMode>(['analytics', 'strict']);

/**
 * `brand-a` → `BRAND_A`, so the env key is the `NOTIFICATIONS_<STORE>_<FIELD>` shape window 17 established.
 * Used for BOTH halves of an override — writing the key and reading it — which is the #586 fix.
 */
export function storeEnvKey(storeCode: string): string {
  return storeCode.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** The full env variable name for one store's override, for an error message a reader can act on. */
export function consentModeEnvFor(storeCode: string): string {
  return `${CONSENT_MODE_ENV_PREFIX}${storeEnvKey(storeCode)}`;
}

export function parseConsentMode(
  raw: string | undefined,
  where: string,
  fallback: ConsentMode,
): ConsentMode {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!MODES.has(value as ConsentMode)) {
    // Throw rather than fall back: a typo like `strcit` must not quietly become the open mode.
    throw new ConsentModeConfigError(`${where} must be "analytics" or "strict" (got "${value}")`);
  }
  return value as ConsentMode;
}

/**
 * Every `ENGAGEMENT_CDP_CONSENT_MODE_<STORE>` in the environment, keyed by the NORMALISED store key and
 * parsed now so a bad value fails the boot.
 *
 * Two spellings of one store that disagree (`..._BRAND_A=strict` and `..._brand-a=analytics`) throw: there is
 * no safe answer, and letting whichever `Object.entries` yielded last win is how a region ends up on the open
 * mode by accident. Two that agree are harmless and allowed.
 */
export function readConsentModeOverrides(
  env: Record<string, string | undefined>,
  fallback: ConsentMode,
): Map<string, ConsentMode> {
  const overrides = new Map<string, ConsentMode>();
  const setBy = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(CONSENT_MODE_ENV_PREFIX)) continue;
    const suffix = key.slice(CONSENT_MODE_ENV_PREFIX.length);
    if (!suffix) {
      // The bare prefix with nothing after it (#590 review: this used to be skipped). It names no store, so
      // whoever set it believes they configured something; silently ignoring it is the failure mode this
      // whole issue is about.
      throw new ConsentModeConfigError(
        `${key} names no store (it is the prefix with nothing after it): ` +
          `use ${CONSENT_MODE_ENV_PREFIX}<STORE_CODE>, or ${CONSENT_MODE_ENV} for the global default`,
      );
    }
    const storeKey = storeEnvKey(suffix);
    // #644 (medium): a per-store key that is SET BUT EMPTY used to fall back to the global mode, so
    // `ENGAGEMENT_CDP_CONSENT_MODE_BRAND_A=` — an unresolved secret-manager template, a trailing `=` in a
    // compose file — booted cleanly and tracked that store under `analytics` while the operator believed it
    // was strict. The global default may be absent (that is what a default is for); a PER-STORE override is
    // something somebody wrote on purpose, so an empty one is a refusal, not a fallback.
    if (value === undefined || value.trim() === '') {
      throw new ConsentModeConfigError(
        `${key} is set but empty: a per-store override must be "analytics" or "strict" ` +
          `(remove the variable to use ${CONSENT_MODE_ENV}, the global default)`,
      );
    }
    const mode = parseConsentMode(value, key, fallback);
    const first = setBy.get(storeKey);
    const already = overrides.get(storeKey);
    if (first !== undefined && already !== mode) {
      throw new ConsentModeConfigError(
        `${first} and ${key} both set the consent mode for store "${storeKey}" and disagree ` +
          `("${already}" vs "${mode}")`,
      );
    }
    setBy.set(storeKey, first ?? key);
    overrides.set(storeKey, mode);
  }
  return overrides;
}

/**
 * Fails the boot on an override that names no store of this organization (#586).
 *
 * This cannot live in `resolveConfig`: the store list comes from the database. The earliest honest moment is
 * after the CDP consumer has warmed its store codes, so that is where it runs — and only when the CDP is
 * enabled, since a consumer that is not running applies no mode to anything.
 *
 * A key matching nothing is almost always a typo (`..._BRANDA`), and #576's whole promise is that a region's
 * legal rules are a config change. An override that silently does nothing is therefore the one failure this
 * switch must never have: it looks exactly like `strict` was applied while every event is still being sent.
 */
export function assertConsentModeOverridesKnown(
  overrides: ReadonlyMap<string, ConsentMode>,
  storeCodes: readonly string[],
): void {
  if (overrides.size === 0) return;

  // #644: an override whose key matches TWO known store codes cannot say which store it means.
  // `brand-a` and `brand_a` are both `BRAND_A`, and `store.code` is unique per organization as TEXT, so
  // both can exist — and then one override silently applies to both stores. A privacy switch that cannot be
  // addressed must not be guessed at, so it refuses, naming the pair.
  //
  // NARROWED to keys actually in use (manager decision, #644): without an override a collision changes
  // nothing — both stores take the global mode — and store codes are created from the onboarding UI, so
  // refusing on any collision would let one store creation stop the CDP for every store. The ambiguity only
  // bites when somebody addresses it.
  const byKey = new Map<string, string[]>();
  for (const code of storeCodes) {
    const key = storeEnvKey(code);
    byKey.set(key, [...(byKey.get(key) ?? []), code]);
  }
  const ambiguous = [...overrides.keys()]
    .map((key) => [key, byKey.get(key) ?? []] as const)
    .filter(([, codes]) => codes.length > 1);
  if (ambiguous.length > 0) {
    const detail = ambiguous
      .map(
        ([key, codes]) =>
          `${CONSENT_MODE_ENV_PREFIX}${key} matches ${[...codes].sort().join(' and ')}`,
      )
      .join('; ');
    throw new ConsentModeConfigError(
      `a per-store consent mode cannot say which store it means: ${detail}. ` +
        `Rename one of the store codes, or set the mode globally with ${CONSENT_MODE_ENV}`,
    );
  }
  const known = new Set(storeCodes.map(storeEnvKey));
  const unknown = [...overrides.keys()].filter((key) => !known.has(key));
  if (unknown.length === 0) return;
  const named = unknown.map((key) => `${CONSENT_MODE_ENV_PREFIX}${key}`).join(', ');
  const codes = [...storeCodes].sort().join(', ') || '(this organization has no stores)';
  throw new ConsentModeConfigError(
    `${named}: no such store in this organization, so the override would silently do nothing ` +
      `(known store codes: ${codes})`,
  );
}
