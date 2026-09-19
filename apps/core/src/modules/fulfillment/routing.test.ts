// Warehouse routing without a database: every rule in order, the store override, and what malformed settings do.
import { describe, expect, it } from 'vitest';
import { regionOf, routeFulfillment, routingSettingsFrom } from './routing';
import type { WarehouseCandidate } from './types';

const EU: WarehouseCandidate = { id: 'w-eu', code: 'wh-eu', country: 'NL', priority: 10 };
const US: WarehouseCandidate = { id: 'w-us', code: 'wh-us', country: 'US', priority: 20 };
const candidates = [US, EU];
const noSettings = { countries: {}, default: null };

const route = (country: string, settings = noSettings, list = candidates) =>
  routeFulfillment({ destinationCountry: country, candidates: list, settings });

describe('routeFulfillment', () => {
  it('sends an EU order to wh-eu and a US order to wh-us', () => {
    expect(route('NL')).toEqual({ warehouse: EU, rule: 'same_country' });
    expect(route('DE')).toEqual({ warehouse: EU, rule: 'same_region' });
    expect(route('FR')).toEqual({ warehouse: EU, rule: 'same_region' });
    expect(route('US')).toEqual({ warehouse: US, rule: 'same_country' });
  });

  it('serves the rest of Europe and North America by region', () => {
    expect(route('GB').warehouse).toBe(EU); // brand B ships to GB
    expect(route('CH').warehouse).toBe(EU);
    expect(route('CA')).toEqual({ warehouse: US, rule: 'same_region' });
    expect(route('mx').warehouse).toBe(US); // case-insensitive
  });

  it('falls back to the lowest priority for a country with no region', () => {
    expect(route('JP')).toEqual({ warehouse: EU, rule: 'priority' });
    expect(route('AU')).toEqual({ warehouse: EU, rule: 'priority' });
  });

  it('lets a store send one country elsewhere, overriding every automatic rule', () => {
    const settings = { countries: { DE: 'wh-us' }, default: null };
    expect(route('DE', settings)).toEqual({ warehouse: US, rule: 'store_country' });
    // Other countries keep the automatic rules.
    expect(route('FR', settings)).toEqual({ warehouse: EU, rule: 'same_region' });
  });

  it('lets a store set a default that wins over the automatic rules but not over a country entry', () => {
    const settings = { countries: { NL: 'wh-eu' }, default: 'wh-us' };
    expect(route('FR', settings)).toEqual({ warehouse: US, rule: 'store_default' });
    expect(route('NL', settings)).toEqual({ warehouse: EU, rule: 'store_country' });
  });

  it('ignores a store setting that names no active warehouse', () => {
    const settings = { countries: { DE: 'wh-closed' }, default: 'wh-gone' };
    expect(route('DE', settings)).toEqual({ warehouse: EU, rule: 'same_region' });
  });

  it('breaks priority ties by code and returns null with no warehouses at all', () => {
    const a: WarehouseCandidate = { id: 'a', code: 'wh-a', country: 'JP', priority: 5 };
    const b: WarehouseCandidate = { id: 'b', code: 'wh-b', country: 'JP', priority: 5 };
    expect(route('AU', noSettings, [b, a]).warehouse).toBe(a);
    expect(route('NL', noSettings, [])).toBeNull();
  });
});

describe('routingSettingsFrom', () => {
  it('reads countries and default, upper-casing country codes', () => {
    expect(
      routingSettingsFrom({
        fulfillment: { routing: { countries: { de: 'wh-us', FR: 'wh-eu' }, default: 'wh-eu' } },
      }),
    ).toEqual({ countries: { DE: 'wh-us', FR: 'wh-eu' }, default: 'wh-eu' });
  });

  it('ignores anything malformed instead of failing an order', () => {
    const empty = { countries: {}, default: null };
    expect(routingSettingsFrom(null)).toEqual(empty);
    expect(routingSettingsFrom({})).toEqual(empty);
    expect(routingSettingsFrom({ fulfillment: 'yes' })).toEqual(empty);
    expect(
      routingSettingsFrom({ fulfillment: { routing: { countries: ['DE'], default: 7 } } }),
    ).toEqual(empty);
    expect(
      routingSettingsFrom({ fulfillment: { routing: { countries: { DE: '', FR: 3 } } } }),
    ).toEqual(empty);
  });
});

describe('regionOf', () => {
  it('knows the regions this platform ships to and nothing else', () => {
    expect(regionOf('nl')).toBe('europe');
    expect(regionOf('GB')).toBe('europe');
    expect(regionOf('US')).toBe('north_america');
    expect(regionOf('JP')).toBeNull();
  });
});
