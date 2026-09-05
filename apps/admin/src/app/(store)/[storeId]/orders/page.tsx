import { StoreSectionGuard } from '@/components/shell/section-guard';
import { SectionPlaceholder } from '@/components/shell/section-placeholder';

export default async function OrdersPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  return (
    <StoreSectionGuard storeId={storeId} id="orders">
      <SectionPlaceholder
        title="Orders"
        delivers="window 4 in Phase 2"
        description="Order list and detail with fulfilment, refunds and returns."
      />
    </StoreSectionGuard>
  );
}
