import { HqSectionGuard } from '@/components/shell/section-guard';
import { OverviewView } from '../_v2/components/overview';
import type { Raw } from '../_v2/model';

export const dynamic = 'force-dynamic';

/**
 * HQ · BI · Overview (#871, BI v2 wave 1). Every request happens inside the section guard: a
 * principal without `analyst` on hq gets the 403 panel and the metrics API is never called.
 */
export default async function HqOverviewPage({ searchParams }: { searchParams: Promise<Raw> }) {
  const raw = await searchParams;
  return (
    <HqSectionGuard id="bi">
      <OverviewView raw={raw} base="/bi" />
    </HqSectionGuard>
  );
}
