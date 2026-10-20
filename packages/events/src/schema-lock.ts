// The published-schema lock (issue #532): schemas/published.lock.json holds the canonical inlined form of every
// schema version that has been published (merged), keyed `topic@version`. The test compares every schema file
// against its locked copy with the offline BACKWARD checker:
//   - no entry            → a new version (or topic): run `schemas:lock` to publish it
//   - identical           → fine
//   - changed, compatible → accepted only through an explicit `schemas:lock` (visible in the PR diff)
//   - changed, breaking   → never: `schemas:lock` refuses it; the change needs a new v<N+1>.json
// This is the offline baseline the registry mirrors; CI needs no registry to enforce it.
import { EVENT_SCHEMAS } from './generated/schemas.js';
import {
  backwardIncompatibilities,
  formatIncompatibilities,
  type Incompatibility,
} from './schema-compat.js';
import { canonicalJson, inlineCommonRefs, schemaDigest } from './schema-inline.js';

export interface LockEntry {
  sha256: string;
  schema: unknown;
}

export interface SchemaLock {
  $comment: string;
  schemas: Record<string, LockEntry>;
}

export const LOCK_COMMENT =
  'Canonical inlined form of every PUBLISHED event schema version (packages/events, #532). Updated only by `pnpm --filter @platform/events schemas:lock`, which refuses a backward-incompatible change to a published version. Do not edit by hand.';

/** The lock the current schema files would produce. */
export function currentLockEntries(): Record<string, LockEntry> {
  const out: Record<string, LockEntry> = {};
  for (const key of Object.keys(EVENT_SCHEMAS).sort()) {
    const schema = inlineCommonRefs((EVENT_SCHEMAS as Record<string, unknown>)[key]);
    out[key] = {
      sha256: schemaDigest(schema),
      schema: JSON.parse(canonicalJson(schema)) as unknown,
    };
  }
  return out;
}

export type LockVerdict =
  | { key: string; state: 'unchanged' }
  | { key: string; state: 'new' }
  | { key: string; state: 'changed_compatible' }
  | { key: string; state: 'changed_breaking'; incompatibilities: Incompatibility[] }
  | { key: string; state: 'removed' };

/** Every schema version against the lock. */
export function compareWithLock(
  lock: SchemaLock | null,
  current = currentLockEntries(),
): LockVerdict[] {
  const locked = lock?.schemas ?? {};
  const verdicts: LockVerdict[] = [];
  for (const [key, entry] of Object.entries(current)) {
    const was = locked[key];
    if (!was) {
      verdicts.push({ key, state: 'new' });
      continue;
    }
    if (was.sha256 === entry.sha256) {
      verdicts.push({ key, state: 'unchanged' });
      continue;
    }
    const incompatibilities = backwardIncompatibilities(was.schema, entry.schema);
    verdicts.push(
      incompatibilities.length === 0
        ? { key, state: 'changed_compatible' }
        : { key, state: 'changed_breaking', incompatibilities },
    );
  }
  for (const key of Object.keys(locked)) {
    if (!(key in current)) verdicts.push({ key, state: 'removed' });
  }
  return verdicts;
}

/** The message the CI test prints for a verdict that is not `unchanged`. */
export function explainVerdict(v: LockVerdict): string {
  switch (v.state) {
    case 'unchanged':
      return `${v.key}: unchanged`;
    case 'new':
      return `${v.key}: not in schemas/published.lock.json — run \`pnpm --filter @platform/events schemas:lock\` to publish it (new topics and new versions only)`;
    case 'changed_compatible':
      return `${v.key}: a PUBLISHED version changed (backward-compatibly). Accept it explicitly with \`pnpm --filter @platform/events schemas:lock\` and bump the package version, or move the change to v<N+1>.json`;
    case 'changed_breaking':
      return `${v.key}: a PUBLISHED version changed and the change is NOT backward compatible — ${formatIncompatibilities(v.incompatibilities)}. A breaking change needs a new file v<N+1>.json; the published file stays as it was`;
    case 'removed':
      return `${v.key}: a published version was deleted; published schemas are never removed`;
  }
}

/**
 * The lock to write: current entries, refusing when any published version changed incompatibly or was removed.
 * Returns the verdicts so the caller can print what it accepted.
 */
export function buildLock(previous: SchemaLock | null): {
  lock: SchemaLock;
  verdicts: LockVerdict[];
} {
  const current = currentLockEntries();
  const verdicts = compareWithLock(previous, current);
  const blocked = verdicts.filter((v) => v.state === 'changed_breaking' || v.state === 'removed');
  if (blocked.length > 0) {
    throw new Error(
      `schemas:lock refused:\n${blocked.map((v) => `  ${explainVerdict(v)}`).join('\n')}`,
    );
  }
  return { lock: { $comment: LOCK_COMMENT, schemas: current }, verdicts };
}
