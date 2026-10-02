import { describe, expect, it } from 'vitest';
import packageJson from '../package.json';
import { componentOverrides } from '@/brand/components';
import { layoutOverrides } from '@/brand/layouts';
import { brandTokens } from '@/brand/tokens';

/**
 * What is true of the starter and of nothing generated from it: it ships no brand (#278).
 *
 * A brand app copies `test/**` on every re-sync and keeps its own `src/brand/**`, so these
 * assertions are false by construction in a clone — the first token a brand sets would turn them
 * red. They therefore run only where the package *is* the starter. Keyed on the package name
 * because it is the one thing every generated app must change, so a clone needs no exclude list and
 * cannot inherit the check by forgetting one.
 */
const STARTER_PACKAGE = '@platform/storefront-starter';

describe.runIf(packageJson.name === STARTER_PACKAGE)('the starter ships no brand', () => {
  it('overrides no component or layout slot', () => {
    expect(componentOverrides).toEqual({});
    expect(layoutOverrides).toEqual({});
  });

  it('ships no token overrides, so it renders the kit defaults', () => {
    expect(brandTokens).toEqual({});
  });
});
