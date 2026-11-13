import type { ReactNode } from 'react';
import { ApiStatePanel, ForbiddenPanel, requiresRelation } from '@/components/states/state-panel';
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
 *
 * Only when `GET /admin/me` ANSWERED and the relation is missing. A failed principal read (401,
 * 503 from a fail-closed OpenFGA, no answer) is shown as what it is — telling the owner "you need
 * the owner relation" because `/admin/me` failed once was a lying panel (#860).
 */
export async function HqSectionGuard({ id, children }: { id: string; children: ReactNode }) {
  const result = await loadPrincipal();
  if (!result.ok) return <ApiStatePanel status={result.status} error={result.error} />;
  if (visibleHqSections(result.data).some((section) => section.id === id)) {
    return <>{children}</>;
  }
  const required = HQ_SECTIONS.find((section) => section.id === id)?.requires[0];
  return (
    <ForbiddenPanel
      {...(required === undefined ? {} : { error: requiresRelation(required, 'organization:hq') })}
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
  if (!result.ok) return <ApiStatePanel status={result.status} error={result.error} />;
  if (visibleStoreSections(result.data, storeId).some((s) => s.id === id)) {
    return <>{children}</>;
  }
  const required = STORE_SECTIONS.find((section) => section.id === id)?.requires[0];
  return (
    <ForbiddenPanel
      {...(required === undefined ? {} : { error: requiresRelation(required, `store:${storeId}`) })}
    />
  );
}
