// The comparison every identity uses: two keyed tables of integer fields (minor units or counts), compared field by
// field. A key present on one side only is compared against 0, so a missing row is a difference, never a silent
// match. Pure: no I/O.

export type Figures = Record<string, number>;
export type Keyed = Map<string, Figures>;

export interface Difference {
  identity: string;
  /** `store=… day=… currency=…`: the key's parts, in order. */
  key: string;
  field: string;
  /** The left source (named in the identity), the right source, and right − left. */
  left: number;
  right: number;
  diff: number;
}

export interface IdentityResult {
  identity: string;
  left: string;
  right: string;
  /** Keys compared (the union of both sides). */
  keys: number;
  differences: Difference[];
}

export function keyOf(parts: Record<string, string | number | null | undefined>): string {
  return Object.entries(parts)
    .map(([k, v]) => `${k}=${v ?? '∅'}`)
    .join(' ');
}

/** Adds `figures` into `into` at `key` (summing field by field). */
export function addTo(into: Keyed, key: string, figures: Figures): void {
  const cur = into.get(key) ?? {};
  for (const [f, v] of Object.entries(figures)) cur[f] = (cur[f] ?? 0) + v;
  into.set(key, cur);
}

export function compare(
  identity: string,
  sides: { left: string; right: string },
  left: Keyed,
  right: Keyed,
  fields: readonly string[],
): IdentityResult {
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  const differences: Difference[] = [];
  for (const key of keys) {
    const l = left.get(key) ?? {};
    const r = right.get(key) ?? {};
    for (const field of fields) {
      const a = l[field] ?? 0;
      const b = r[field] ?? 0;
      if (a !== b) differences.push({ identity, key, field, left: a, right: b, diff: b - a });
    }
  }
  return { identity, left: sides.left, right: sides.right, keys: keys.length, differences };
}

/** A check that lists offending keys rather than comparing figures (lineage). */
export function listing(
  identity: string,
  sides: { left: string; right: string },
  keys: number,
  offending: readonly { key: string; field: string }[],
): IdentityResult {
  return {
    identity,
    left: sides.left,
    right: sides.right,
    keys,
    differences: offending.map((o) => ({
      identity,
      key: o.key,
      field: o.field,
      left: 1,
      right: 0,
      diff: -1,
    })),
  };
}

/** Integers only: a float or a non-number from an API is a defect, not a rounding question. */
export function int(v: unknown, what: string): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n))
    throw new TypeError(`${what} is not an integer: ${String(v)}`);
  return n;
}
