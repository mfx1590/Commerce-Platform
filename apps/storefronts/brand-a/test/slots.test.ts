import { describe, expect, it } from 'vitest';
import { componentOverrides } from '@/brand/components';
import { layoutOverrides } from '@/brand/layouts';
import { defaultComponents } from '@/components/defaults';
import { defaultLayouts } from '@/layouts/defaults';
import { getComponents, getLayouts } from '@/lib/slots';
import { brandTokens } from '@/brand/tokens';

describe('slot registries', () => {
  it('expose every slot, falling back to the starter default', () => {
    expect(Object.keys(getComponents()).sort()).toEqual(['Announcement', 'Logo']);
    expect(Object.keys(getLayouts()).sort()).toEqual(['Footer', 'Header']);
  });

  it('uses the starter implementations while a brand overrides nothing', () => {
    expect(componentOverrides).toEqual({});
    expect(layoutOverrides).toEqual({});
    expect(getComponents().Logo).toBe(defaultComponents.Logo);
    expect(getLayouts().Header).toBe(defaultLayouts.Header);
  });

  it('ships no token overrides, so the starter renders the kit defaults', () => {
    expect(brandTokens).toEqual({});
  });
});
