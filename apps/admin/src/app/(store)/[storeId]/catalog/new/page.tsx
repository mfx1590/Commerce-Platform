import { StoreSectionGuard } from '@/components/shell/section-guard';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { createProductAction } from '@/app/actions/catalog';
import { listCategories } from '@/lib/api/admin';
import { ProductForm } from '../product-form';

export const dynamic = 'force-dynamic';

export default async function NewProductPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const categories = await listCategories(storeId);

  return (
    <StoreSectionGuard storeId={storeId} id="catalog">
      <Card>
        <CardHeader title="New product" description="Creating a product needs store_staff." />
        <CardBody>
          <ProductForm
            action={createProductAction.bind(null, storeId)}
            categories={categories.ok ? categories.data.items : []}
            submitLabel="Create product"
            redirectBase={`/${storeId}/catalog`}
            defaultValues={{ handle: '', title: '', options: [], media: [] }}
          />
        </CardBody>
      </Card>
    </StoreSectionGuard>
  );
}
