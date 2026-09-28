import { describe, expect, it } from 'vitest';
import { componentOverrides } from '@/brand/components';
import { layoutOverrides } from '@/brand/layouts';
import { defaultComponents } from '@/components/defaults';
import { defaultLayouts } from '@/layouts/defaults';
import { getComponents, getLayouts } from '@/lib/slots';

/**
 * TEMPORARY DEVIATION FROM THE STARTER — see REQUEST #278, and the README's diff table.
 *
 * The starter's version of this file also asserts `componentOverrides`, `layoutOverrides` and
 * `brandTokens` are all `{}`. Those assertions are true for the starter and false by construction
 * in any app generated from it: a brand clone exists in order to set them. Brand A sets tokens in
 * 2.2, so they are removed here.
 *
 * `test/slots.test.ts` is in the clone's PRESERVE list while #278 is open. When window 3 moves the
 * starter-only assertions out, drop it from PRESERVE, re-sync, and delete this comment — the
 * mechanism tests below are the starter's and should come back from the starter.
 *
 * Brand A's own theme is covered by `test/brand-theme.test.ts`, which is brand-owned either way.
 */
describe('slot registries', () => {
  it('expose every slot, falling back to the starter default', () => {
    expect(Object.keys(getComponents()).sort()).toEqual(['Announcement', 'Logo']);
    expect(Object.keys(getLayouts()).sort()).toEqual(['Footer', 'Header']);
  });

  it('uses the starter implementations for the slots brand A does not override', () => {
    // Brand A themes with tokens only — it replaces no component or layout slot (DESIGN.md §5).
    expect(componentOverrides).toEqual({});
    expect(layoutOverrides).toEqual({});
    expect(getComponents().Logo).toBe(defaultComponents.Logo);
    expect(getLayouts().Header).toBe(defaultLayouts.Header);
  });
});
