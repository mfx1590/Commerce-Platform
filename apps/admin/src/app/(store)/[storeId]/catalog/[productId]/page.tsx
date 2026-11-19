import Link from 'next/link';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import { ApiStatePanel } from '@/components/states/state-panel';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { updateProductAction } from '@/app/actions/catalog';
import { VariantsPanel } from './variants-panel';
import {
  getProduct,
  getStore,
  listCategories,
  listPriceLists,
  listProductMedia,
} from '@/lib/api/admin';
import { CATALOG_PERMISSIONS } from '@/lib/catalog/permissions';
import { holds } from '@/lib/permissions/rules';
import { MediaPanel } from './media-panel';
import { currentCopy, mayDraftCopy } from '@/lib/copy-drafts';
import { loadPrincipal } from '@/lib/principal';
import { CopyDraftPanel } from './copy-draft-panel';
import type { ProductCreateValues } from '@/lib/forms/schemas';
import { ProductForm } from '../product-form';
import { PublishControls } from './publish-controls';
import { ActivityPanel, activityPage } from '@/components/audit/activity-panel';
import { loadActivity } from '@/lib/audit/load';

export const dynamic = 'force-dynamic';

export default async function ProductDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string; productId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { storeId, productId } = await params;
  const page = activityPage((await searchParams)?.['activity']);
  const [product, categories, store, principal, activity, priceLists, media] = await Promise.all([
    getProduct(storeId, productId),
    listCategories(storeId),
    getStore(storeId),
    loadPrincipal(),
    loadActivity({ storeId, entityType: 'product', entityId: productId, page }),
    // Which prices the variant editor may change: the default lists only (#947 review).
    listPriceLists(storeId),
    // #870 item 5 (PR B): the media panel reads the images itself (viewer).
    listProductMedia(storeId, productId),
  ]);
  const canEditMedia =
    principal.ok && holds(principal.data, CATALOG_PERMISSIONS.addProductMedia, storeId);
  const canDraft = principal.ok && mayDraftCopy(principal.data, storeId);

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
    seo: (current.seo as Record<string, unknown> | undefined) ?? {},
    attributes: (current.attributes as Record<string, unknown> | undefined) ?? {},
    options: current.options.map((option) => ({ name: option.name, values: option.values })),
    // No `media`: on this page the media panel owns the images. `updateProduct` REPLACES the whole
    // set when `media` is sent, so a stale list from this form would undo the panel's uploads.
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
            {/* Keyed by updated_at: after any save (the AI panel's included) the form remounts on
                the saved values, so a later "Save changes" never writes the old copy back. */}
            <ProductForm
              key={current.updated_at}
              action={updateProductAction.bind(null, storeId, productId)}
              defaultValues={defaultValues}
              categories={categories.ok ? categories.data.items : []}
              submitLabel="Save changes"
              mediaInPanel
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Draft copy with AI"
            description="A draft beside the current copy: edit it, keep the fields you want, then save. Nothing is saved until you press Save."
          />
          <CardBody>
            {store.ok ? (
              <CopyDraftPanel
                storeId={storeId}
                productId={productId}
                locales={
                  store.data.locales.length > 0 ? store.data.locales : [store.data.default_locale]
                }
                defaultLocale={store.data.default_locale}
                canDraft={canDraft}
                current={currentCopy(current)}
                product={{
                  description: current.description,
                  seo: (current.seo as Record<string, unknown> | undefined) ?? {},
                }}
                settingsHref={`/${storeId}/settings`}
              />
            ) : (
              <ApiStatePanel
                status={store.status}
                error={store.error}
                what="This store"
                storeId={storeId}
              />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Variants"
            description="Saving options does not create variants — each one is a sellable thing with its own SKU and price, so they are created here, deliberately."
          />
          <CardBody>
            <VariantsPanel
              storeId={storeId}
              product={current}
              defaultPriceListIds={
                priceLists.ok
                  ? priceLists.data.items
                      .filter((list) => list.type === 'default')
                      .map((list) => list.id)
                  : null
              }
              priceListNames={
                priceLists.ok
                  ? Object.fromEntries(priceLists.data.items.map((list) => [list.id, list.name]))
                  : {}
              }
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Images"
            description="Uploaded straight to the image host. The first image is the product thumbnail; every image needs alt text."
          />
          <CardBody>
            <MediaPanel
              storeId={storeId}
              productId={productId}
              media={media.ok ? media.data.items : []}
              error={media.ok ? null : media.error.message}
              variants={current.variants.map((variant) => ({
                id: variant.id,
                title: variant.title,
              }))}
              canEdit={canEditMedia}
            />
          </CardBody>
        </Card>

        <ActivityPanel
          activity={activity}
          entityType="product"
          basePath={`/${storeId}/catalog/${productId}`}
          note="Changes to a variant or to media are recorded against that variant or image, not here."
        />
      </div>
    </StoreSectionGuard>
  );
}
