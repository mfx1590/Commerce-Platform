/**
 * The pure half of `scripts/seed.mjs`: reading credentials from the environment, building the
 * Sanity HTTP API URLs and the mutation batch, and the manual fallback steps. No network here, so
 * it is unit-tested; the script is the thin runner around it.
 */

import { BRAND_DATASETS, SANITY_API_VERSION } from './datasets.js';
import { PLACEHOLDER_ASSET_REF } from './fixtures/index.js';

export interface SeedEnv {
  projectId: string | undefined;
  token: string | undefined;
  apiVersion: string;
}

export function readSeedEnv(env: Record<string, string | undefined>): SeedEnv {
  return {
    projectId: env['SANITY_PROJECT_ID'] || undefined,
    token: env['SANITY_WRITE_TOKEN'] || undefined,
    apiVersion: env['SANITY_API_VERSION'] || SANITY_API_VERSION,
  };
}

/** Names of the variables still missing — empty when the seed can run. */
export function missingCredentials(env: SeedEnv): string[] {
  const missing: string[] = [];
  if (!env.projectId) missing.push('SANITY_PROJECT_ID');
  if (!env.token) missing.push('SANITY_WRITE_TOKEN');
  return missing;
}

export function apiBase(projectId: string, apiVersion: string): string {
  return `https://${projectId}.api.sanity.io/v${apiVersion}`;
}

export function mutateUrl(projectId: string, apiVersion: string, dataset: string): string {
  return `${apiBase(projectId, apiVersion)}/data/mutate/${dataset}?returnIds=true`;
}

export function assetUploadUrl(projectId: string, apiVersion: string, dataset: string): string {
  return `${apiBase(projectId, apiVersion)}/assets/images/${dataset}?filename=placeholder.png`;
}

/** A 1×1 transparent PNG: the asset every fixture image points at after seeding. */
export const PLACEHOLDER_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function replaceAssetRefs<T>(value: T, assetRef: string): T {
  if (Array.isArray(value)) {
    return value.map((item) => replaceAssetRefs(item, assetRef)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        key === '_ref' && inner === PLACEHOLDER_ASSET_REF
          ? assetRef
          : replaceAssetRefs(inner, assetRef);
    }
    return out as T;
  }
  return value;
}

export interface CreateOrReplaceMutation {
  createOrReplace: Record<string, unknown>;
}

/**
 * `createOrReplace` so a re-run overwrites the fixtures (deterministic ids) instead of failing or
 * duplicating them; every placeholder image reference is rewritten to the uploaded asset.
 */
export function buildMutations(
  documents: readonly Record<string, unknown>[],
  assetRef: string,
): CreateOrReplaceMutation[] {
  return documents.map((document) => ({
    createOrReplace: replaceAssetRefs(document, assetRef),
  }));
}

/** Datasets to seed from a `--dataset` argument: one brand, or `all`. */
export function resolveDatasets(argument: string | undefined): string[] {
  const all: string[] = BRAND_DATASETS.map((brand) => brand.dataset);
  if (!argument) return [all[0]!];
  if (argument === 'all') return all;
  if (!all.includes(argument)) {
    throw new Error(`Unknown dataset "${argument}" (use one of ${all.join(', ')}, or all)`);
  }
  return [argument];
}

/** What a person does by hand when there are no credentials. Printed by the script, quoted in README. */
export function manualSteps(dataset: string, missing: string[]): string {
  return [
    `No Sanity credentials (${missing.join(', ')} not set in .env) — nothing was written.`,
    'Seed the fixtures by hand:',
    `  1. In sanity.io/manage create (or open) the project and add a dataset named "${dataset}" (private).`,
    '  2. Add a token with Editor rights under API → Tokens; put it in .env as SANITY_WRITE_TOKEN,',
    '     and the project id as SANITY_PROJECT_ID. Never commit .env.',
    '  3. Re-run: pnpm --filter @platform/cms seed -- --dataset ' + dataset,
    '  — or, without a token: pnpm --filter @platform/cms studio, open the workspace for',
    `     "${dataset}", and create one document per type following cms/src/fixtures/index.ts`,
    '     (upload any image where the fixture has a placeholder; alt text is required).',
  ].join('\n');
}
