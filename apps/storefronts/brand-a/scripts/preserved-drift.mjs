/**
 * Which PRESERVED files' starter counterparts have changed since the last sync.
 *
 * A preserved file is copied once and never overwritten, so a fix the starter makes to it never
 * arrives. That is the point of preserving it — and the cost: on 2026-10-03 four of them
 * (`next.config.mjs`, `src/brand/config.ts`, `playwright.config.ts`, `lighthouserc.json`) were found
 * days behind, missing #274's `htmlLimitedBots` and #320's fail-closed origin, and nothing had said
 * so. This makes it say so.
 *
 * Each sync records the starter's git blob id for every preserved path in
 * `scripts/starter-preserved.json`. The next sync and every `--check` compare against it. A
 * changed id means "port this by hand"; the sync cannot, because the brand's copy differs on
 * purpose. Reported, never fatal to the repo-wide suite — like the package manifest, a stale record
 * is a correct state that only matters to whoever is about to sync.
 *
 * Kept apart from the record of the starter's package.json (`starter-manifest.json`): that file
 * *is* the starter's package.json and is handed to the merge as such, so extra keys in it would be
 * read as package fields.
 */

/**
 * @param {Record<string, string> | undefined} previous blob id per path at the last sync
 * @param {Record<string, string>} current blob id per path in the starter today
 * @returns {string[]} one `~`/`+`/`-` line per drifted path, sorted; `[]` when there is no record
 */
export function preservedDrift(previous, current) {
  if (previous === undefined) return [];
  const drift = [];
  for (const file of Object.keys(current).sort()) {
    if (!(file in previous)) drift.push(`+ ${file} (new in the starter since the last sync)`);
    else if (previous[file] !== current[file]) drift.push(`~ ${file}`);
  }
  for (const file of Object.keys(previous).sort()) {
    if (!(file in current)) drift.push(`- ${file} (gone from the starter)`);
  }
  return drift;
}

/**
 * `git ls-files -s` output → blob id per path, for the paths `keep` accepts. Index blob ids rather
 * than a hash of the working tree: they are identical on Windows and Linux whatever `core.autocrlf`
 * does to the checkout.
 *
 * @param {string} lsFilesStage
 * @param {(file: string) => boolean} keep
 * @returns {Record<string, string>}
 */
export function blobIds(lsFilesStage, keep) {
  /** @type {Record<string, string>} */
  const ids = {};
  for (const line of lsFilesStage.split('\n')) {
    const match = /^\d+ ([0-9a-f]+) \d+\t(.+)$/.exec(line.trim());
    if (match && keep(match[2])) ids[match[2]] = match[1];
  }
  return ids;
}
