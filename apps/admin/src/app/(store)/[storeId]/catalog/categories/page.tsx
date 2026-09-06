import Link from 'next/link';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import { RequestErrorPanel } from '@/components/states/state-panel';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { listCategories } from '@/lib/api/admin';
import { CategoriesPanel } from './categories-panel';

export const dynamic = 'force-dynamic';

export default async function CategoriesPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const categories = await listCategories(storeId);

  return (
    <StoreSectionGuard storeId={storeId} id="catalog">
      <Card>
        <CardHeader
          title="Categories"
          description="The category tree for this store. Creating one needs store_staff."
          action={
            <Link href={`/${storeId}/catalog`} className="text-accent text-sm hover:underline">
              Back to products
            </Link>
          }
        />
        <CardBody>
          {categories.ok ? (
            <CategoriesPanel storeId={storeId} categories={categories.data.items} />
          ) : (
            <RequestErrorPanel status={categories.status} error={categories.error} />
          )}
        </CardBody>
      </Card>
    </StoreSectionGuard>
  );
}
