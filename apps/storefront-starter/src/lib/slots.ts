import type { ComponentType } from 'react';
import { componentOverrides } from '@/brand/components';
import { layoutOverrides } from '@/brand/layouts';
import { defaultComponents } from '@/components/defaults';
import { defaultLayouts } from '@/layouts/defaults';
import type { Store } from './store-api';

/**
 * Brand override mechanism, part 2 of 3 (part 1 is tokens, part 3 is whole route files).
 *
 * A page never imports a header or a logo directly — it asks for a slot. A brand app replaces one
 * by exporting it from `src/brand/layouts` or `src/brand/components`; everything else keeps the
 * starter's implementation, so a re-sync from the starter (ADR 0004) touches no brand code.
 *
 * The registries are resolved lazily: a default layout may itself ask for a component slot (the
 * header renders the `Logo`), and a getter keeps that from depending on module evaluation order.
 */

export interface ComponentSlots {
  Logo: ComponentType<{ storeName: string }>;
  /** Thin strip above the header. The default renders nothing. */
  Announcement: ComponentType<{ store: Store | null }>;
}

export interface LayoutSlots {
  Header: ComponentType<{ store: Store | null }>;
  Footer: ComponentType<{ store: Store | null }>;
}

/** Skips keys explicitly set to `undefined`, so a partial override never blanks a default. */
function mergeSlots<T extends object>(defaults: T, overrides: Partial<T>): T {
  const merged = { ...defaults };
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) Object.assign(merged, { [name]: value });
  }
  return merged;
}

let resolvedComponents: ComponentSlots | undefined;
let resolvedLayouts: LayoutSlots | undefined;

export function getComponents(): ComponentSlots {
  resolvedComponents ??= mergeSlots(defaultComponents, componentOverrides);
  return resolvedComponents;
}

export function getLayouts(): LayoutSlots {
  resolvedLayouts ??= mergeSlots(defaultLayouts, layoutOverrides);
  return resolvedLayouts;
}
