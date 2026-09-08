import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_LOCALES,
  BRAND_DATASETS,
  LOCALE_PATTERN,
  datasetForStore,
  isBrandDataset,
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
  it('mirror the seeded store codes and locales', () => {
    const seeded = seededStores();
    expect(seeded.length).toBeGreaterThan(0);
    expect(BRAND_DATASETS.map((b) => ({ code: b.storeCode, locales: [...b.locales] }))).toEqual(
      seeded,
    );
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

  it('only publish in xx-YY locales', () => {
    expect(ALL_LOCALES).toEqual(['en-GB', 'de-DE', 'en-US']);
    for (const locale of ALL_LOCALES) expect(locale).toMatch(LOCALE_PATTERN);
    expect('en').not.toMatch(LOCALE_PATTERN);
  });
});
