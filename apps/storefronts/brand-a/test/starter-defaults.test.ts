import { describe, expect, it } from 'vitest';
import packageJson from '../package.json';

/**
 * What is true of the starter and of nothing generated from it: it ships no brand (#278).
 *
 * A brand app copies `test/**` on every re-sync and keeps its own `src/brand/**`, so these
 * assertions are false by construction in a clone — the first token a brand sets would turn them
 * red. They therefore run only where the package *is* the starter. Keyed on the package name
 * because it is the one thing every generated app must change, so a clone needs no exclude list and
 * cannot inherit the check by forgetting one.
 *
 * The brand modules are imported inside the gated tests, never at the top: a clone's `src/brand/**`
 * may call `next/font/local` at module scope, which exists only under Next's compiler, so a static
 * import would fail collection before `runIf` is consulted (#326).
 */
const STARTER_PACKAGE = '@platform/storefront-starter';

describe.runIf(packageJson.name === STARTER_PACKAGE)('the starter ships no brand', () => {
  it('overrides no component or layout slot', async () => {
    const { componentOverrides } = await import('@/brand/components');
    const { layoutOverrides } = await import('@/brand/layouts');
    expect(componentOverrides).toEqual({});
    expect(layoutOverrides).toEqual({});
  });

  it('ships no token overrides, so it renders the kit defaults', async () => {
    const { brandTokens } = await import('@/brand/tokens');
    expect(brandTokens).toEqual({});
  });
});
