import { HqSectionGuard } from '@/components/shell/section-guard';
import { BiReport, type BiParams } from './_components/bi-report';

export const dynamic = 'force-dynamic';

/**
 * HQ BI (#480, window 12): sales per store and currency, finance for finance principals, stock per store — from the
 * Admin API report operations (#479). Currency is a tab and is never summed: every figure on the page belongs to
 * the selected currency. Every request happens inside the section guard, so a principal without `analyst` gets
 * the 403 panel and the API is never called.
 */
export default async function BiPage({ searchParams }: { searchParams: Promise<BiParams> }) {
  const raw = await searchParams;
  return (
    <HqSectionGuard id="bi">
      <BiReport params={raw} />
    </HqSectionGuard>
  );
}
