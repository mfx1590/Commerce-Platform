import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_ASSET_REF,
  PLACEHOLDER_PNG_BASE64,
  assetUploadUrl,
  buildMutations,
  fixtureDocuments,
  manualSteps,
  missingCredentials,
  mutateUrl,
  readSeedEnv,
  resolveDatasets,
} from '../src/index.js';

describe('seed helpers', () => {
  it('reads credentials from the environment only, with the pinned API version as default', () => {
    const env = readSeedEnv({
      SANITY_PROJECT_ID: 'abc123',
      SANITY_WRITE_TOKEN: 'sk',
      SANITY_API_VERSION: '',
    });
    expect(env).toEqual({ projectId: 'abc123', token: 'sk', apiVersion: '2025-02-19' });
    expect(missingCredentials(env)).toEqual([]);
    expect(missingCredentials(readSeedEnv({}))).toEqual([
      'SANITY_PROJECT_ID',
      'SANITY_WRITE_TOKEN',
    ]);
  });

  it('builds the HTTP API urls', () => {
    expect(mutateUrl('abc123', '2025-02-19', 'brand-a')).toBe(
      'https://abc123.api.sanity.io/v2025-02-19/data/mutate/brand-a?returnIds=true',
    );
    expect(assetUploadUrl('abc123', '2025-02-19', 'brand-b')).toBe(
      'https://abc123.api.sanity.io/v2025-02-19/assets/images/brand-b?filename=placeholder.png',
    );
  });

  it('rewrites every placeholder image reference and uses createOrReplace', () => {
    const mutations = buildMutations(
      fixtureDocuments as unknown as Record<string, unknown>[],
      'image-abc-1x1-png',
    );
    expect(mutations).toHaveLength(fixtureDocuments.length);
    const json = JSON.stringify(mutations);
    expect(json).not.toContain(PLACEHOLDER_ASSET_REF);
    expect(json).toContain('image-abc-1x1-png');
    expect(mutations.every((m) => 'createOrReplace' in m)).toBe(true);
    // the source fixtures are untouched
    expect(JSON.stringify(fixtureDocuments)).toContain(PLACEHOLDER_ASSET_REF);
  });

  it('ships a real PNG as the placeholder asset', () => {
    const bytes = Buffer.from(PLACEHOLDER_PNG_BASE64, 'base64');
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('resolves --dataset to one brand, all brands, or an error', () => {
    expect(resolveDatasets(undefined)).toEqual(['brand-a']);
    expect(resolveDatasets('brand-c')).toEqual(['brand-c']);
    expect(resolveDatasets('all')).toEqual(['brand-a', 'brand-b', 'brand-c']);
    expect(() => resolveDatasets('production')).toThrow(/Unknown dataset "production"/);
  });

  it('prints manual steps that name the missing variables and never a value', () => {
    const text = manualSteps('brand-a', ['SANITY_WRITE_TOKEN']);
    expect(text).toContain('SANITY_WRITE_TOKEN not set');
    expect(text).toContain('nothing was written');
    expect(text).toContain('seed -- --dataset brand-a');
    expect(text).toContain('Never commit .env');
  });
});
