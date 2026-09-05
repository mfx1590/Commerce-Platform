import { StoreSectionGuard } from '@/components/shell/section-guard';
import { SectionPlaceholder } from '@/components/shell/section-placeholder';

export default async function CustomersPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  return (
    <StoreSectionGuard storeId={storeId} id="customers">
      <SectionPlaceholder
        title="Customers"
        delivers="window 4 in Phase 2"
        description="Customer accounts, groups and addresses for this store."
      />
    </StoreSectionGuard>
  );
}
