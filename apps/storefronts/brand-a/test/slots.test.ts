import { describe, expect, it } from 'vitest';
import { componentOverrides } from '@/brand/components';
import { layoutOverrides } from '@/brand/layouts';
import { defaultComponents } from '@/components/defaults';
import { defaultLayouts } from '@/layouts/defaults';
import { getComponents, getLayouts, mergeSlots } from '@/lib/slots';

/**
 * The slot mechanism — true in the starter **and in every app generated from it**.
 *
 * `test/**` is copied into a brand app on every re-sync while `src/brand/**` is the brand's own, so
 * nothing here may assert what this app's brand files contain: "the brand overrides nothing" is a
 * fact about the starter alone and lives in `test/starter-defaults.test.ts` (#278). The merge rule is
 * exercised with fixture overrides; the registries are checked against whatever this app overrides.
 */

describe('mergeSlots', () => {
  const defaults = { Logo: () => 'default logo', Announcement: () => 'default announcement' };

  it('keeps every default when nothing is overridden', () => {
    expect(mergeSlots(defaults, {})).toEqual(defaults);
  });

  it('replaces only the slot a brand overrides', () => {
    const Logo = () => 'brand logo';
    const merged = mergeSlots(defaults, { Logo });

    expect(merged.Logo).toBe(Logo);
    expect(merged.Announcement).toBe(defaults.Announcement);
  });

  it('never blanks a default with an override explicitly set to undefined', () => {
    // `exactOptionalPropertyTypes` rejects this at compile time; a brand's plain-JS spread does not.
    const overrides = { Logo: undefined } as unknown as Partial<typeof defaults>;
    const merged = mergeSlots(defaults, overrides);
    expect(merged.Logo).toBe(defaults.Logo);
  });

  it('does not mutate the defaults it was given', () => {
    const original = defaults.Logo;
    mergeSlots(defaults, { Logo: () => 'brand logo' });
    expect(defaults.Logo).toBe(original);
  });
});

describe('slot registries', () => {
  it('expose every slot', () => {
    expect(Object.keys(getComponents()).sort()).toEqual(['Announcement', 'Logo']);
    expect(Object.keys(getLayouts()).sort()).toEqual(['Footer', 'Header']);
  });

  it("resolve each slot to this app's override where there is one, else to the starter default", () => {
    const components = getComponents();
    for (const name of Object.keys(defaultComponents) as (keyof typeof defaultComponents)[]) {
      expect(components[name]).toBe(componentOverrides[name] ?? defaultComponents[name]);
    }

    const layouts = getLayouts();
    for (const name of Object.keys(defaultLayouts) as (keyof typeof defaultLayouts)[]) {
      expect(layouts[name]).toBe(layoutOverrides[name] ?? defaultLayouts[name]);
    }
  });
});
