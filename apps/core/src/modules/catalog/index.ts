// Public API of the catalog module. Nothing outside this folder may import from its other files.
export {
  addMedia,
  archiveProduct,
  createCategory,
  deleteMedia,
  updateMedia,
  createProduct,
  createVariant,
  getProduct,
  listCategories,
  listProducts,
  publishProduct,
  toAdminProduct,
  toAdminVariant,
  updateProduct,
  updateVariant,
} from './service';
export { getStoreProduct, listStoreCategories, listStoreProducts } from './read-model';
// the catalogue re-publish (#634): a catalogue that predates the bus, announced as product.published
export { republishCatalogue } from './republish';
export type { RepublishOptions, RepublishResult } from './republish';
// AI copy drafts (#608): a draft, never written to the product
export {
  COPY_FIELDS,
  COPY_TEMPLATE,
  DEFAULT_AUDIENCE,
  DEFAULT_BRAND_VOICE,
  draftProductCopy,
  parseDraft,
  setCopyDraftGatewayFactory,
} from './copy-draft';
export type {
  CopyDraftGatewayFactory,
  CopyField,
  DraftProductCopyInput,
  ProductCopyDraft,
} from './copy-draft';
export { PRODUCT_SORT_FIELDS } from './types';
export type { MediaInput, MediaPatch } from './service';
export type {
  AdminCategory,
  AdminProduct,
  AdminProductQuery,
  AdminVariant,
  CategoryInput,
  Money,
  Page,
  PageQuery,
  ProductInput,
  ProductSortField,
  ProductStatus,
  SortOrder,
  StoreCategory,
  StoreProduct,
  StoreProductQuery,
  StoreProductSummary,
  StoreSort,
  StoreVariant,
  VariantInput,
} from './types';
