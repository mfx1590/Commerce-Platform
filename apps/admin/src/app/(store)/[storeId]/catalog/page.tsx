import { StoreSectionGuard } from '@/components/shell/section-guard';
import { SectionPlaceholder } from '@/components/shell/section-placeholder';

export default async function CatalogPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  return (
    <StoreSectionGuard storeId={storeId} id="catalog">
      <SectionPlaceholder
        title="Catalog"
        delivers="issue #28"
        description="Products, options and variants, media, categories, publish and archive."
      />
    </StoreSectionGuard>
  );
}
