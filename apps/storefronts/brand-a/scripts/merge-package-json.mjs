/**
 * The `package.json` MERGE mode for `sync-from-starter.mjs`.
 *
 * **Why this exists.** `package.json` was on the PRESERVE list, because it carries the brand's
 * identity — its name, its version, its dev port. But preserve is all-or-nothing: it also froze
 * everything the starter added afterwards. That is not theoretical. The starter gained `perf` and
 * `bundle-budget` in its task 2.3 and brand A never received them; the gap was found by hand during
 * 2.2, months later, and only because someone went looking. Brand B would have rediscovered it the
 * same way.
 *
 * So `package.json` gets a third mode, between copy and preserve: **merge**. Identity survives,
 * everything else tracks the starter.
 *
 * Kept as its own module with no filesystem access so the rules can be unit-tested directly —
 * `test/sync-merge.test.ts` asserts both halves of the contract, that a starter addition arrives
 * and that the brand's identity survives.
 */

/**
 * Top-level fields that belong to the brand. Everything else at the top level takes the starter's
 * value, so a new field the starter adds (an `engines` block, a `packageManager` pin) arrives.
 */
const BRAND_FIELDS = ['name', 'version', 'description'];

/**
 * Scripts whose *value* is brand identity rather than shared behaviour. `dev` hard-codes the port
 * (3101 here, 3100 in the starter), so taking the starter's value would silently move the app.
 *
 * Note what is deliberately NOT here: `start`, `build`, `test`, `e2e`, `perf`, `lighthouse`. Those
 * are the starter's to improve, and brand A wants the improvements. `scripts/start.mjs` is on the
 * PRESERVE list and carries the port, so `start` needs no override of its own.
 */
const BRAND_SCRIPTS = ['dev'];

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'];

/**
 * Merge one record, starter-first.
 *
 * The starter's entries win for keys both define — that is the point, it is how a version bump or a
 * changed script body arrives. Keys only the brand has survive, because a brand legitimately adds
 * its own (brand A's `sync` script, and `@axe-core/playwright` for its a11y suite).
 *
 * **Deletions.** A key the brand has and the starter does not is ambiguous on its own: either the
 * brand added it, or the starter *removed* it and the brand is holding a corpse. The first version
 * of this merge could not tell the difference, so anything the starter deleted survived in every
 * brand forever — a dead script or an unused dependency that no re-sync would ever clear.
 *
 * `previousStarter` resolves it. It is the starter's own record from the last sync, written by the
 * sync script: a key present there and absent now was deleted upstream, and goes. A key in neither
 * was the brand's own, and stays.
 *
 * Without a `previousStarter` — the first sync after this feature, or a fresh clone — nothing is
 * dropped. Deleting a brand's dependency because we lack the evidence to keep it is the worse
 * failure, so the ambiguous case stays conservative and the next sync has the record it needs.
 *
 * **Two rules follow from this, and they are worth stating plainly.**
 *
 * A key in `keepBrandValueFor` is *never* deleted. Those are identity (`dev`, which carries the
 * port), and a starter rename — `dev` becoming `dev:web` — is indistinguishable from a deletion by
 * the record alone. Treating it as one would drop the brand's port, which is the single thing this
 * merge exists to protect.
 *
 * A key **both sides carry** is starter-managed: the starter's value wins while it exists, and it
 * goes when the starter drops it. A brand that needs to keep such a key has to say so by adding it
 * to `keepBrandValueFor`, not by relying on it having been there.
 *
 * @param {Record<string, string>} [starter]
 * @param {Record<string, string>} [brand]
 * @param {readonly string[]} [keepBrandValueFor]
 * @param {Record<string, string>} [previousStarter]
 */
function mergeRecord(
  starter = {},
  brand = {},
  keepBrandValueFor = [],
  previousStarter = undefined,
) {
  const keep = new Set(keepBrandValueFor);
  const merged = { ...starter };

  for (const [key, value] of Object.entries(brand)) {
    if (key in starter) {
      // Shared key: the starter wins, unless this one's value is brand identity.
      if (keep.has(key)) merged[key] = value;
      continue;
    }
    // Brand-only *now*. Did the starter have it last time?
    //
    // An identity key is never deleted, whatever the record says. If the starter renames `dev` to
    // `dev:web`, the old name is in the record and gone from the starter, which looks exactly like
    // a deletion — and dropping it would take brand A's `next dev --port 3101` with it, breaking
    // the one thing this merge promises to protect. A rename is not a deletion of identity.
    const deletedUpstream = previousStarter !== undefined && key in previousStarter;
    if (keep.has(key) || !deletedUpstream) merged[key] = value;
  }

  return merged;
}

/**
 * Merge the starter's `package.json` into the brand's.
 *
 * All three arguments are parsed objects; the result is a new object and none of the inputs is
 * mutated. `previousStarter` is the starter's `package.json` as of the last sync (see `mergeRecord`)
 * and may be omitted, in which case nothing is treated as deleted.
 *
 * @param {Record<string, unknown>} starter
 * @param {Record<string, unknown>} brand
 * @param {Record<string, unknown>} [previousStarter]
 * @returns {Record<string, unknown>}
 */
export function mergePackageJson(starter, brand, previousStarter = undefined) {
  const merged = { ...starter };

  for (const field of BRAND_FIELDS) {
    if (field in brand) merged[field] = brand[field];
    else delete merged[field];
  }

  // Brand-only top-level keys survive, unless the starter deleted them — the same rule as below.
  for (const [key, value] of Object.entries(brand)) {
    if (key in starter || DEPENDENCY_FIELDS.includes(key) || key === 'scripts') continue;
    const deletedUpstream = previousStarter !== undefined && key in previousStarter;
    if (!deletedUpstream) merged[key] = value;
  }

  merged.scripts = mergeRecord(
    starter.scripts,
    brand.scripts,
    BRAND_SCRIPTS,
    previousStarter?.scripts,
  );

  for (const field of DEPENDENCY_FIELDS) {
    if (starter[field] === undefined && brand[field] === undefined) continue;
    merged[field] = sortKeys(
      mergeRecord(starter[field], brand[field], [], previousStarter?.[field]),
    );
  }

  return merged;
}

/** npm writes dependency blocks sorted; an unsorted merge would churn the diff on every sync. */
function sortKeys(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

export const MERGE_RULES = { BRAND_FIELDS, BRAND_SCRIPTS, DEPENDENCY_FIELDS };
