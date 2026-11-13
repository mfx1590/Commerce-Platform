import type { ComponentSlots } from '@/lib/slots';

/**
 * Brand override mechanism, part 2a: component slots.
 *
 * Export a component here to replace the starter's version everywhere it is used — typically the
 * `Logo`, or an `Announcement` strip driven by the brand's CMS. Slots not listed keep the starter's
 * implementation, so re-syncing from the starter never conflicts with brand code.
 *
 * If a brand needs a primitive that does not exist, it goes into `@platform/ui` for everyone
 * (ADR 0004): never patch the kit's internals from here.
 */
export const componentOverrides: Partial<ComponentSlots> = {
  // Logo: BrandLogo,
};
