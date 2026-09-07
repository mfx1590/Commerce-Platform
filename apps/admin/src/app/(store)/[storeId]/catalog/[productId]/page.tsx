import Link from 'next/link';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import { ApiStatePanel } from '@/components/states/state-panel';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { updateProductAction } from '@/app/actions/catalog';
import { VariantsPanel } from './variants-panel';
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
        <ApiStatePanel
          status={product.status}
          error={product.error}
          what="This product"
          storeId={storeId}
          backHref={`/${storeId}/catalog`}
          backLabel="All products"
        />
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
    media: current.media.map((item) => ({
      url: item.url,
      alt: item.alt,
      position: item.position,
      ...(item.variant_id === undefined ? {} : { variant_id: item.variant_id }),
    })),
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
            description="Saving options does not create variants — each one is a sellable thing with its own SKU and price, so they are created here, deliberately."
          />
          <CardBody>
            <VariantsPanel storeId={storeId} product={current} />
          </CardBody>
        </Card>
      </div>
    </StoreSectionGuard>
  );
}
