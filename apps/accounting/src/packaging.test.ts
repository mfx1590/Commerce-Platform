// #658: the shipped image never contains the month generator. @platform/test-utils (the generated month and an
// owner-pool writer) is a devDependency only, and the build (tsconfig.json) leaves out the two modules that import it
// — the posting fixtures and the payout fixture builder, which run from source through tsx (`pnpm fixtures:payouts`).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

describe('packaging (#658)', () => {
  it('@platform/test-utils is a devDependency, never a runtime one', () => {
    const pkg = json('../package.json');
    expect(pkg.dependencies['@platform/test-utils']).toBeUndefined();
    expect(pkg.devDependencies['@platform/test-utils']).toBe('workspace:*');
  });

  it('the build excludes the modules that import it; the generator script runs from source', () => {
    const ts = json('../tsconfig.json');
    expect(ts.exclude).toEqual(
      expect.arrayContaining(['src/posting/fixtures.ts', 'src/reconcile/fixtures/**']),
    );
    expect(json('../package.json').scripts['fixtures:payouts'].startsWith('tsx src/')).toBe(true);
  });
});
