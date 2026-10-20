import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_LOCALES,
  BRAND_DATASETS,
  DATASET_NAME_MAX_LENGTH,
  LOCALE_PATTERN,
  datasetForStore,
  datasetsFromEnv,
  isBrandDataset,
  isDatasetName,
  resolveDataset,
} from '../src/index.js';

/**
 * The seed in packages/db is the source of truth for store codes and locales. Reading its source
 * (instead of importing the package) keeps this package free of a dependency on the database
 * client, and still fails loudly when a brand is added or renamed there.
 */
function seededStores(): { code: string; locales: string[] }[] {
  const source = readFileSync(
    resolve(__dirname, '..', '..', 'packages', 'db', 'src', 'seed', 'index.ts'),
    'utf8',
  );
  const stores: { code: string; locales: string[] }[] = [];
  const re = /code: '(brand-[a-z])',[\s\S]*?locales: \[([^\]]*)\]/g;
  for (const match of source.matchAll(re)) {
    stores.push({
      code: match[1]!,
      locales: [...match[2]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!),
    });
  }
  return stores;
}

describe('datasets', () => {
  it('list every seeded store with its locales (a superset: UI-onboarded brands may be added)', () => {
    const seeded = seededStores();
    expect(seeded.length).toBeGreaterThan(0);
    const listed = new Map(
      BRAND_DATASETS.map((b) => [b.storeCode, [...b.locales]] as [string, string[]]),
    );
    for (const store of seeded) {
      expect(listed.get(store.code), store.code).toEqual(store.locales);
    }
    // #521: a brand onboarded from the admin UI is not in the seed, so the list may hold more —
    // but never fewer, and never a seeded brand with other locales.
    expect(BRAND_DATASETS.length).toBeGreaterThanOrEqual(seeded.length);
  });

  it('name each dataset after its store code (= store.content_space_id)', () => {
    for (const brand of BRAND_DATASETS) {
      expect(brand.dataset).toBe(brand.storeCode);
      expect(datasetForStore(brand.storeCode)).toBe(brand.dataset);
      expect(isBrandDataset(brand.dataset)).toBe(true);
      expect(brand.locales).toContain(brand.defaultLocale);
    }
    expect(isBrandDataset('production')).toBe(false);
    expect(() => datasetForStore('brand-z')).toThrow(/No CMS dataset for store "brand-z"/);
  });

  it('isDatasetName: Sanity’s rule, length-capped, never repaired', () => {
    for (const ok of ['brand-a', 'brand_d', 'b2', 'a'.repeat(DATASET_NAME_MAX_LENGTH)]) {
      expect(isDatasetName(ok), ok).toBe(true);
    }
    for (const bad of [
      '',
      ' brand-a',
      'Brand-A',
      '-brand',
      '_brand',
      'brand a',
      'brand/a',
      'brand.a',
      'a'.repeat(DATASET_NAME_MAX_LENGTH + 1),
      null,
      undefined,
      42,
      {},
    ]) {
      expect(isDatasetName(bad), String(bad)).toBe(false);
    }
  });

  it('resolveDataset: content_space_id first, then the seeded list, then null — never a throw', () => {
    // a UI-onboarded brand: not in the list, its content space id carries the dataset
    expect(resolveDataset({ storeCode: 'brand-z', contentSpaceId: 'brand-z' })).toBe('brand-z');
    expect(resolveDataset({ storeCode: 'brand-z', contentSpaceId: 'north-2026' })).toBe(
      'north-2026',
    );
    // the content space id wins over the list when both exist (decision 8: they are equal anyway)
    expect(resolveDataset({ storeCode: 'brand-a', contentSpaceId: 'brand-a-staging' })).toBe(
      'brand-a-staging',
    );
    // absent or invalid content space id → the seeded list
    expect(resolveDataset({ storeCode: 'brand-a' })).toBe('brand-a');
    expect(resolveDataset({ storeCode: 'brand-a', contentSpaceId: null })).toBe('brand-a');
    expect(resolveDataset({ storeCode: 'brand-a', contentSpaceId: '' })).toBe('brand-a');
    expect(resolveDataset({ storeCode: 'brand-a', contentSpaceId: 'Brand A' })).toBe('brand-a');
    expect(resolveDataset({ storeCode: 'brand-a', contentSpaceId: '../production' })).toBe(
      'brand-a',
    );
    // nothing usable → null
    expect(resolveDataset({ storeCode: 'brand-z' })).toBeNull();
    expect(resolveDataset({ storeCode: 'brand-z', contentSpaceId: 'Not valid' })).toBeNull();
    expect(resolveDataset({ storeCode: null })).toBeNull();
    expect(resolveDataset({ storeCode: null, contentSpaceId: null })).toBeNull();
    // but a valid content space id needs no store code at all
    expect(resolveDataset({ storeCode: null, contentSpaceId: 'brand-z' })).toBe('brand-z');
  });

  it('datasetsFromEnv: optional extra Studio workspaces, validated, seeded ones deduplicated', () => {
    expect(datasetsFromEnv(undefined)).toEqual([]);
    expect(datasetsFromEnv('')).toEqual([]);
    expect(datasetsFromEnv(' , ')).toEqual([]);
    expect(datasetsFromEnv('brand-z')).toEqual(['brand-z']);
    expect(datasetsFromEnv(' brand-z, north-2026 ,brand-z,brand-a ')).toEqual([
      'brand-z',
      'north-2026',
    ]);
    expect(() => datasetsFromEnv('brand-z,Brand Z')).toThrow(/"Brand Z" is not a dataset name/);
    expect(() => datasetsFromEnv('a'.repeat(65))).toThrow(/not a dataset name/);
  });

  it('only publish in xx-YY locales', () => {
    expect(ALL_LOCALES).toEqual(['en-GB', 'de-DE', 'en-US']);
    for (const locale of ALL_LOCALES) expect(locale).toMatch(LOCALE_PATTERN);
    expect('en').not.toMatch(LOCALE_PATTERN);
  });
});
