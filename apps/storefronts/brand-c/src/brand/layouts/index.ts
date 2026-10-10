import type { LayoutSlots } from '@/lib/slots';

/**
 * Brand override mechanism, part 2b: layout slots.
 *
 * Export `Header` or `Footer` here to replace the starter's chrome wholesale — a brand with a mega
 * menu or a market switcher writes its own and leaves every page file untouched.
 */
export const layoutOverrides: Partial<LayoutSlots> = {
  // Header: BrandHeader,
};
