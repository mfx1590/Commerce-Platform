import { StoreSectionGuard } from '@/components/shell/section-guard';
import { SectionPlaceholder } from '@/components/shell/section-placeholder';

export default async function ContentPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  return (
    <StoreSectionGuard storeId={storeId} id="content">
      <SectionPlaceholder
        title="Content"
        delivers="window 6 in Phase 2"
        description="Landing pages and content entries linked to this store."
      />
    </StoreSectionGuard>
  );
}
