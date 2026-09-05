import Link from 'next/link';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import { RequestErrorPanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { updateProductAction } from '@/app/actions/catalog';
import { getProduct, listCategories } from '@/lib/api/admin';
import type { ProductCreateValues } from '@/lib/forms/schemas';
import { ProductForm } from '../product-form';
import { PublishControls } from './publish-controls';

export const dynamic = 'force-dynamic';

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ storeId: string; productId: string }>;
}) {
  const { storeId, productId } = await params;
  const [product, categories] = await Promise.all([
    getProduct(storeId, productId),
    listCategories(storeId),
  ]);

  if (!product.ok) {
    return (
      <StoreSectionGuard storeId={storeId} id="catalog">
        <RequestErrorPanel status={product.status} error={product.error} />
      </StoreSectionGuard>
    );
  }

  const current = product.data;
  const defaultValues: ProductCreateValues = {
    handle: current.handle,
    title: current.title,
    subtitle: current.subtitle,
    description: current.description,
    category_id: current.category_id,
    brand_name: current.brand_name,
    tags: current.tags,
    options: current.options.map((option) => ({ name: option.name, values: option.values })),
  };

  return (
    <StoreSectionGuard storeId={storeId} id="catalog">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{current.title}</h1>
          <span className="text-muted font-mono text-xs">{current.handle}</span>
          <Link
            href={`/${storeId}/catalog`}
            className="text-accent ml-auto text-sm hover:underline"
          >
            All products
          </Link>
        </div>

        <Card>
          <CardHeader
            title="Status"
            description="Publishing emits product.published; archiving never hard-deletes."
          />
          <CardBody>
            <PublishControls storeId={storeId} product={current} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Details" />
          <CardBody>
            <ProductForm
              action={updateProductAction.bind(null, storeId, productId)}
              defaultValues={defaultValues}
              categories={categories.ok ? categories.data.items : []}
              submitLabel="Save changes"
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Variants"
            description={`${current.variants.length} on this product.`}
          />
          <CardBody>
            {current.variants.length === 0 ? (
              <p className="text-muted text-sm">
                No variants yet. Saving options above creates the matrix.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" aria-label="Variants">
                  <thead className="border-line border-b">
                    <tr>
                      <th scope="col" className="px-3 py-2 text-left font-medium">
                        Title
                      </th>
                      <th scope="col" className="px-3 py-2 text-left font-medium">
                        SKU
                      </th>
                      <th scope="col" className="px-3 py-2 text-left font-medium">
                        Options
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-line divide-y">
                    {current.variants.map((variant) => (
                      <tr key={variant.id}>
                        <td className="px-3 py-2">{variant.title}</td>
                        <td className="px-3 py-2 font-mono text-xs">{variant.sku}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {Object.entries(variant.options).map(([name, value]) => (
                              <Badge key={name}>{`${name}: ${value}`}</Badge>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </StoreSectionGuard>
  );
}
