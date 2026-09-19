// Which warehouse ships an order. A pure function over the candidates, so every rule is testable without a
// database, and so the order of the rules is readable in one place:
//
//   1. store override by destination country   store.settings.fulfillment.routing.countries[CC]
//   2. store default                            store.settings.fulfillment.routing.default
//   3. a warehouse in the destination country
//   4. a warehouse in the destination's region  (static map below)
//   5. the lowest `priority` among the rest
//
// Stock-aware allocation — splitting an order across warehouses by what is on the shelf — is window 11's in
// Phase 3. Until then the order goes to one warehouse and the reservation made at placement decides the rest.
import type { RoutingDecision, RoutingSettings, WarehouseCandidate } from './types';

/**
 * Coarse shipping regions: a warehouse ships cheaply within its region and expensively across one. Countries not
 * listed have no region, so rules 3 and 4 skip them and rule 5 decides.
 */
const REGION: Record<string, string> = {
  // European Union
  AT: 'europe',
  BE: 'europe',
  BG: 'europe',
  CY: 'europe',
  CZ: 'europe',
  DE: 'europe',
  DK: 'europe',
  EE: 'europe',
  ES: 'europe',
  FI: 'europe',
  FR: 'europe',
  GR: 'europe',
  HR: 'europe',
  HU: 'europe',
  IE: 'europe',
  IT: 'europe',
  LT: 'europe',
  LU: 'europe',
  LV: 'europe',
  MT: 'europe',
  NL: 'europe',
  PL: 'europe',
  PT: 'europe',
  RO: 'europe',
  SE: 'europe',
  SI: 'europe',
  SK: 'europe',
  // Rest of Europe served from the same warehouses
  GB: 'europe',
  CH: 'europe',
  NO: 'europe',
  IS: 'europe',
  LI: 'europe',
  // North America
  US: 'north_america',
  CA: 'north_america',
  MX: 'north_america',
};

export function regionOf(country: string): string | null {
  return REGION[country.toUpperCase()] ?? null;
}

/** Reads `store.settings.fulfillment.routing`, ignoring anything malformed. */
export function routingSettingsFrom(settings: unknown): RoutingSettings {
  const empty: RoutingSettings = { countries: {}, default: null };
  if (settings === null || typeof settings !== 'object') return empty;
  const fulfillment = (settings as Record<string, unknown>).fulfillment;
  if (fulfillment === null || typeof fulfillment !== 'object') return empty;
  const routing = (fulfillment as Record<string, unknown>).routing;
  if (routing === null || typeof routing !== 'object') return empty;
  const r = routing as Record<string, unknown>;
  const countries: Record<string, string> = {};
  if (r.countries !== null && typeof r.countries === 'object' && !Array.isArray(r.countries)) {
    for (const [country, code] of Object.entries(r.countries as Record<string, unknown>)) {
      if (typeof code === 'string' && code !== '') countries[country.toUpperCase()] = code;
    }
  }
  return {
    countries,
    default: typeof r.default === 'string' && r.default !== '' ? r.default : null,
  };
}

const byPriority = (a: WarehouseCandidate, b: WarehouseCandidate) =>
  a.priority - b.priority || a.code.localeCompare(b.code);

/**
 * Picks the warehouse for a destination country. `candidates` are the organization's active warehouses; returns
 * null only when there are none.
 */
export function routeFulfillment(input: {
  destinationCountry: string;
  candidates: WarehouseCandidate[];
  settings: RoutingSettings;
}): RoutingDecision | null {
  const country = input.destinationCountry.toUpperCase();
  const candidates = [...input.candidates].sort(byPriority);
  if (candidates.length === 0) return null;
  const byCode = (code: string | null | undefined) =>
    code ? candidates.find((warehouse) => warehouse.code === code) : undefined;

  const storeCountry = byCode(input.settings.countries[country]);
  if (storeCountry) return { warehouse: storeCountry, rule: 'store_country' };

  const storeDefault = byCode(input.settings.default);
  if (storeDefault) return { warehouse: storeDefault, rule: 'store_default' };

  const sameCountry = candidates.find((warehouse) => warehouse.country.toUpperCase() === country);
  if (sameCountry) return { warehouse: sameCountry, rule: 'same_country' };

  const region = regionOf(country);
  if (region) {
    const sameRegion = candidates.find((warehouse) => regionOf(warehouse.country) === region);
    if (sameRegion) return { warehouse: sameRegion, rule: 'same_region' };
  }

  return { warehouse: candidates[0]!, rule: 'priority' };
}
