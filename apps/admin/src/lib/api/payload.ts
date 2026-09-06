/**
 * Zod parses `{ is_primary?: boolean }` to `is_primary?: boolean | undefined`, while the generated
 * contract types use exact optional properties (`is_primary?: boolean`). Under
 * `exactOptionalPropertyTypes` those are different types, and the difference is real rather than
 * pedantic: sending `{"is_primary": undefined}` is not the same request as omitting the key, and a
 * PATCH is exactly where that distinction decides whether a field is cleared or left alone.
 *
 * `compact` drops the undefined-valued keys, so what goes over the wire is what the form filled in.
 */
/**
 * Keys that could not be `undefined` stay required; only the ones that could become exact-optional.
 * Widening everything to optional would lose the guarantee that a required field was actually
 * filled in, which is the thing the schema just finished proving.
 */
export type Compacted<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

export function compact<T extends Record<string, unknown>>(value: T): Compacted<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Compacted<T>;
}

/**
 * `compact` for a list of objects. `compact` is shallow by design — it only knows the keys it is
 * handed — so a request body carrying an array of objects with optional fields (product media,
 * variant prices) needs its elements compacted too.
 */
export function compactList<T extends Record<string, unknown>>(
  values: readonly T[],
): Compacted<T>[] {
  return values.map((value) => compact(value));
}
