/**
 * Store settings (#117): who may do what, what reaches the client, and which status changes ask
 * first. Pure, so the role fixtures can be asserted in a table.
 *
 * Every flag mirrors one operation's `x-permission` in Admin API 0.4.6. UI gating is a
 * convenience — the Admin API re-checks each mutation, and a refusal renders as `ActionRefusal` —
 * but a form that will certainly be refused is not offered; the relation it needs is named instead.
 */

import type { AdminComponents } from '../api/admin-client';
import { makeProjection, type ClientSafe } from '../client-safe';
import { findStore, type Principal } from '../nav/navigation';
import { expandOrganizationRelations, expandStoreRelations, type Relation } from '../nav/relations';

type Store = AdminComponents['Store'];
type SalesChannel = AdminComponents['SalesChannel'];

export interface SettingsPermissions {
  /** `updateStore` — store_admin on the store. */
  canEditStore: boolean;
  /** `addDomain` — owner on organization:hq (not store_admin). */
  canAddDomain: boolean;
  /** `createSalesChannel` — store_admin on the store. */
  canCreateChannel: boolean;
  /** `listApiKeys`, `createApiKey` — store_admin on the store. Below it, not even the list. */
  canManageKeys: boolean;
}

export function settingsPermissions(principal: Principal, storeId: string): SettingsPermissions {
  const organization = expandOrganizationRelations(principal.organization_relations as Relation[]);
  const onStore = expandStoreRelations(
    (findStore(principal, storeId)?.relations ?? []) as Relation[],
    principal.organization_relations as Relation[],
  );
  const admin = onStore.has('store_admin');
  return {
    canEditStore: admin,
    canAddDomain: organization.has('owner'),
    canCreateChannel: admin,
    canManageKeys: admin,
  };
}

/** The General form's starting values — six scalars, never the store record. */
export type StoreSettingsDefaults = ClientSafe<
  Pick<
    Store,
    'name' | 'status' | 'default_currency' | 'default_locale' | 'default_country' | 'timezone'
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
  ]);
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
