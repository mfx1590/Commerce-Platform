// The per-store consent-mode ENV contract (#576) and the key validation #586 added.
//
// WHY THIS IS ITS OWN MODULE, and not part of `config.ts`: `config.ts` imports the three consumers for
// `KNOWN_GROUPS`, so a consumer cannot import `config.ts` back without a cycle — and `createCdpConsumer` is
// where the "does this override name a real store?" check belongs, because the store list only exists after
// the consumer has warmed its store codes. Both sides import this instead. It also puts the ONE normalisation
// rule in one place, which is the whole lesson of #586: the bug was a key stored raw and looked up
// normalised, and two copies of a transform are the same bug waiting to happen again.

import type { ConsentMode } from './consent.js';

export const CONSENT_MODE_ENV = 'ENGAGEMENT_CDP_CONSENT_MODE';
export const CONSENT_MODE_ENV_PREFIX = `${CONSENT_MODE_ENV}_`;

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
    throw new Error(`${where} must be "analytics" or "strict" (got "${value}")`);
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
    if (!suffix) continue;
    const storeKey = storeEnvKey(suffix);
    const mode = parseConsentMode(value, key, fallback);
    const first = setBy.get(storeKey);
    const already = overrides.get(storeKey);
    if (first !== undefined && already !== mode) {
      throw new Error(
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
  const known = new Set(storeCodes.map(storeEnvKey));
  const unknown = [...overrides.keys()].filter((key) => !known.has(key));
  if (unknown.length === 0) return;
  const named = unknown.map((key) => `${CONSENT_MODE_ENV_PREFIX}${key}`).join(', ');
  const codes = [...storeCodes].sort().join(', ') || '(this organization has no stores)';
  throw new Error(
    `${named}: no such store in this organization, so the override would silently do nothing ` +
      `(known store codes: ${codes})`,
  );
}
