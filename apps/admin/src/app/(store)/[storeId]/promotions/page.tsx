import { StoreSectionGuard } from '@/components/shell/section-guard';
import { SectionPlaceholder } from '@/components/shell/section-placeholder';

export default async function PromotionsPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  return (
    <StoreSectionGuard storeId={storeId} id="promotions">
      <SectionPlaceholder
        title="Promotions"
        delivers="window 9 in Phase 2"
        description="Price lists, discounts and campaigns for this store."
      />
    </StoreSectionGuard>
  );
}
