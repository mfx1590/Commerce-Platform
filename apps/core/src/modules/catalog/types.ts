import type { AdminComponents, StoreComponents } from '@platform/contracts';

// ---- Admin API shapes (what the catalog services return; task 1.7 routes are thin) ----
export type AdminCategory = AdminComponents['schemas']['Category'];
export type CategoryInput = AdminComponents['schemas']['CategoryInput'];
export type AdminProduct = AdminComponents['schemas']['Product'];
export type ProductInput = AdminComponents['schemas']['ProductInput'];
export type AdminVariant = AdminComponents['schemas']['Variant'];
export type VariantInput = AdminComponents['schemas']['VariantInput'];
export type AdminProductOption = AdminProduct['options'][number];
export type AdminProductMedia = AdminProduct['media'][number];
export type ProductStatus = AdminProduct['status'];

// ---- Store API shapes (read model; task 1.6 routes are thin) ----
export type StoreCategory = StoreComponents['schemas']['Category'];
export type StoreProduct = StoreComponents['schemas']['Product'];
export type StoreProductSummary = StoreComponents['schemas']['ProductSummary'];
export type StoreVariant = StoreComponents['schemas']['Variant'];
export type Money = StoreComponents['schemas']['Money'];

export interface PageQuery {
  page?: number;
  limit?: number;
}
export interface Page<T> {
  page: number;
  limit: number;
  total: number;
  items: T[];
}

export interface AdminProductQuery extends PageQuery {
  q?: string;
  status?: ProductStatus;
  category_id?: string;
}

export type StoreSort = 'relevance' | 'price_asc' | 'price_desc' | 'newest';
export interface StoreProductQuery extends PageQuery {
  q?: string | undefined;
  /** Category handle; includes descendants. */
  category?: string | undefined;
  tag?: string | undefined;
  sort?: StoreSort | undefined;
}

// ---- rows ----
export interface CategoryRow {
  id: string;
  handle: string;
  name: string;
  description: string | null;
  parent_id: string | null;
  position: number;
  is_active: boolean;
}

export interface ProductRow {
  id: string;
  store_id: string;
  handle: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  status: ProductStatus;
  category_id: string | null;
  brand_name: string | null;
  tags: string[];
  attributes: Record<string, unknown>;
  seo: Record<string, unknown>;
  thumbnail_url: string | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface OptionRow {
  id: string;
  product_id: string;
  name: string;
  values: string[];
  position: number;
}

export interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  barcode: string | null;
  title: string;
  options: Record<string, string>;
  manage_inventory: boolean;
  allow_backorder: boolean;
  weight_g: number | null;
  dimensions_mm: { l?: number; w?: number; h?: number } | null;
  hs_code: string | null;
  origin_country: string | null;
  position: number;
}

export interface PriceRow {
  variant_id: string;
  price_list_id: string;
  currency: string;
  amount_minor: string;
  compare_at_minor: string | null;
  min_quantity: number;
}

export interface InventoryRow {
  variant_id: string;
  warehouse_id: string;
  on_hand: number;
  reserved: number;
  available: number;
}

export interface MediaRow {
  id: string;
  product_id: string;
  variant_id: string | null;
  url: string;
  alt: string | null;
  position: number;
}
