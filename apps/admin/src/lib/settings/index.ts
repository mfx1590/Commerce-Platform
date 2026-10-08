/**
 * Store settings (#117): who may do what, what reaches the client, and which status changes ask
 * first. Pure, so the role fixtures can be asserted in a table.
 *
 * Every flag mirrors one operation's `x-permission` in Admin API 0.4.8 (`REGISTRY_PERMISSIONS`).
 * The same table gates the server actions before they call the API (`../permissions/guard.ts`), and the Admin
 * API re-checks each mutation again; UI gating is only the convenience on top. A form that will
 * certainly be refused is not offered; the relation it needs is named instead.
 */

import type { AdminComponents } from '../api/admin-client';
import { makeProjection, type ClientSafe } from '../client-safe';
import type { Principal } from '../nav/navigation';
import { holds, ruleObject, type PermissionRule } from '../permissions/rules';

type Store = AdminComponents['Store'];
type SalesChannel = AdminComponents['SalesChannel'];
type ApiKey = AdminComponents['ApiKey'];

/**
 * The registry mutations and the `x-permission` each one carries in `admin-api.yaml`. One table,
 * read by the page (what to offer) and by the server actions (what to refuse before the API).
 * `test/settings.test.tsx` pins every row against the spec file itself.
 */
export const REGISTRY_PERMISSIONS = {
  createStore: { relation: 'owner', object: 'organization' },
  updateStore: { relation: 'store_admin', object: 'store' },
  addDomain: { relation: 'owner', object: 'organization' },
  updateDomain: { relation: 'owner', object: 'organization' },
  createSalesChannel: { relation: 'store_admin', object: 'store' },
  createApiKey: { relation: 'store_admin', object: 'store' },
  revokeApiKey: { relation: 'store_admin', object: 'store' },
  onboardStore: { relation: 'owner', object: 'organization' },
  activateStore: { relation: 'owner', object: 'organization' },
} as const satisfies Record<string, PermissionRule>;

export type RegistryOperation = keyof typeof REGISTRY_PERMISSIONS;

/** The object an operation's `x-permission` names, as the Admin API writes it in a 403. */
export function permissionObject(operation: RegistryOperation, storeId: string): string {
  return ruleObject(REGISTRY_PERMISSIONS[operation], storeId);
}

/** Whether the principal holds the relation `operation` requires (implied relations included). */
export function mayPerform(
  principal: Principal,
  operation: RegistryOperation,
  storeId: string,
): boolean {
  return holds(principal, REGISTRY_PERMISSIONS[operation], storeId);
}

export interface SettingsPermissions {
  /** `updateStore` — store_admin on the store (name, status, defaults, enabled sets). */
  canEditStore: boolean;
  /** `addDomain` — owner on organization:hq (not store_admin). */
  canAddDomain: boolean;
  /** `updateDomain` (move the primary flag) — owner on organization:hq. */
  canMovePrimary: boolean;
  /** `createSalesChannel` — store_admin on the store. */
  canCreateChannel: boolean;
  /** `listApiKeys`, `createApiKey`, `revokeApiKey` — store_admin. Below it, not even the list. */
  canManageKeys: boolean;
}

export function settingsPermissions(principal: Principal, storeId: string): SettingsPermissions {
  const may = (operation: RegistryOperation) => mayPerform(principal, operation, storeId);
  return {
    canEditStore: may('updateStore'),
    canAddDomain: may('addDomain'),
    canMovePrimary: may('updateDomain'),
    canCreateChannel: may('createSalesChannel'),
    canManageKeys: may('createApiKey') && may('revokeApiKey'),
  };
}

/** The General form's starting values — six scalars and the two enabled sets, never the record. */
export type StoreSettingsDefaults = ClientSafe<
  Pick<
    Store,
    | 'name'
    | 'status'
    | 'default_currency'
    | 'default_locale'
    | 'default_country'
    | 'timezone'
    | 'currencies'
    | 'locales'
  >
>;

export function forStoreSettings(store: Store): StoreSettingsDefaults {
  return makeProjection(store, [
    'name',
    'status',
    'default_currency',
    'default_locale',
    'default_country',
    'timezone',
    'currencies',
    'locales',
  ]);
}

/**
 * An enabled set as `updateStore` should receive it: trimmed, each entry once, the default first.
 * The core keeps the default whatever is sent; sending it too keeps the form and the stored set
 * from disagreeing about what was saved.
 */
export function withDefault(set: readonly string[], fallback: string): string[] {
  const entries = set.map((entry) => entry.trim()).filter((entry) => entry !== '');
  return [...new Set([fallback, ...entries])];
}

/** What the screen says when the core refuses to revoke the last live publishable key. */
export const LAST_LIVE_KEY_MESSAGE =
  "This is the store's last live publishable key — the storefront would lose its only credential. Create another publishable key first, then revoke this one.";

/**
 * The key `revokeApiKey` refuses with 409 `last_live_key`: the store's only publishable key with
 * `revoked_at: null`. Null when there are two or more (or none) — any of them may go.
 */
export function lastLiveKeyId(keys: readonly ApiKey[]): string | null {
  const live = keys.filter((key) => key.type === 'publishable' && key.revoked_at === null);
  return live.length === 1 ? (live[0]?.id ?? null) : null;
}

/** A sales channel as the API key form's select needs it. */
export type ChannelOption = ClientSafe<Pick<SalesChannel, 'id' | 'name'>>;

export function forChannelOptions(channels: readonly SalesChannel[]): ChannelOption[] {
  return channels
    .filter((channel) => channel.is_active)
    .map((channel) => makeProjection(channel, ['id', 'name']));
}

type StoreStatus = Store['status'];

/**
 * Moving a store to `paused` or `archived` takes its storefront offline, so it asks first; any
 * other change (including back to `active`) does not. Returns the question, or null.
 */
export function statusChangeQuestion(from: StoreStatus, to: StoreStatus): string | null {
  if (from === to) return null;
  if (to === 'paused') {
    return 'Pausing takes the storefront offline: customers cannot browse or check out until the store is active again.';
  }
  if (to === 'archived') {
    return 'Archiving takes the storefront offline and retires the store. Orders and records are kept, and the status can be set back to active.';
  }
  return null;
}
