import type { ReactNode } from 'react';
import { ForbiddenPanel } from '@/components/states/state-panel';
import { visibleHqSections, visibleStoreSections } from '@/lib/nav/navigation';
import { HQ_SECTIONS, STORE_SECTIONS } from '@/lib/nav/sections';
import { loadPrincipal } from '@/lib/principal';

/**
 * Per-section gates. The layout only proves the principal has *a* view; these prove they have
 * *this* section, because hiding a nav entry does not stop anyone typing the URL.
 *
 * The panel names the relation the section's own catalogue entry asks for, so the message is
 * actionable ("you need finance on organization:hq") rather than a bare refusal. The Admin API
 * still re-checks `x-permission` on every call underneath.
 */
export async function HqSectionGuard({ id, children }: { id: string; children: ReactNode }) {
  const result = await loadPrincipal();
  if (result.ok && visibleHqSections(result.data).some((section) => section.id === id)) {
    return <>{children}</>;
  }
  const required = HQ_SECTIONS.find((section) => section.id === id)?.requires[0];
  return (
    <ForbiddenPanel
      {...(required === undefined
        ? {}
        : {
            error: {
              code: 'forbidden',
              message: `requires ${required} on organization:hq`,
              details: { relation: required, object: 'organization:hq' },
            },
          })}
    />
  );
}

export async function StoreSectionGuard({
  storeId,
  id,
  children,
}: {
  storeId: string;
  id: string;
  children: ReactNode;
}) {
  const result = await loadPrincipal();
  if (result.ok && visibleStoreSections(result.data, storeId).some((s) => s.id === id)) {
    return <>{children}</>;
  }
  const required = STORE_SECTIONS.find((section) => section.id === id)?.requires[0];
  return (
    <ForbiddenPanel
      {...(required === undefined
        ? {}
        : {
            error: {
              code: 'forbidden',
              message: `requires ${required} on store:${storeId}`,
              details: { relation: required, object: `store:${storeId}` },
            },
          })}
    />
  );
}
