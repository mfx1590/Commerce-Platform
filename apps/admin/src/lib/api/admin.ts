/**
 * Server-side entry point to the Admin API: binds the transport to the configured base URL and the
 * signed-in principal's access token.
 *
 * Adding a screen means adding a typed wrapper here, never calling `fetch` from a component. The
 * type parameter is the contract `operationId`, so `AdminResponse<'listProducts'>` is exactly the
 * response body `admin-api.yaml` documents and a contract rename breaks the build.
 *
 * Contract: Admin API 0.2.0.
 */

import 'server-only';

import type { operations } from '@platform/contracts/admin';
import { env } from '../env';
import { getSession } from '../auth/current-session';
import type {
  AdminComponents,
  AdminRequestOptions,
  AdminResponse,
  ApiResult,
} from './admin-client';
import { adminRequest, buildPath } from './admin-client';

type CallOptions = Omit<AdminRequestOptions, 'baseUrl' | 'accessToken'>;
type Query = Record<string, string | number>;

/** Every Admin API call goes through here, so the token is attached in exactly one place. */
export async function adminCall<K extends keyof operations>(
  options: CallOptions,
): Promise<ApiResult<AdminResponse<K>>> {
  const session = await getSession();
  return adminRequest<K>({
    ...options,
    baseUrl: env.adminApiUrl,
    accessToken: session?.accessToken,
  });
}

// ---------------------------------------------------------------------------- me

/**
 * The principal behind the current session: user, organization, organization-level relations and
 * the stores it may act on. This drives the whole navigation (issue #25) and the store switcher.
 */
export async function getMe(): Promise<ApiResult<AdminResponse<'getMe'>>> {
  return adminCall<'getMe'>({ path: '/admin/me' });
}

// ---------------------------------------------------------------------------- registry

/**
 * The store registry (HQ). Sortable by `code`, `name`, `status` or `created_at`
 * (Admin API 0.2.0) — the caller passes them through `toContractQuery(query, { sortable: true })`.
 */
export async function listStores(query: Query): Promise<ApiResult<AdminResponse<'listStores'>>> {
  return adminCall<'listStores'>({ path: '/admin/stores', query });
}

export async function createStore(
  body: AdminComponents['StoreInput'],
): Promise<ApiResult<AdminResponse<'createStore'>>> {
  return adminCall<'createStore'>({ path: '/admin/stores', method: 'POST', body });
}

export async function getStore(storeId: string): Promise<ApiResult<AdminResponse<'getStore'>>> {
  return adminCall<'getStore'>({ path: buildPath('/admin/stores/{storeId}', { storeId }) });
}

export async function updateStore(
  storeId: string,
  body: AdminComponents['StoreInput'],
): Promise<ApiResult<AdminResponse<'updateStore'>>> {
  return adminCall<'updateStore'>({
    path: buildPath('/admin/stores/{storeId}', { storeId }),
    method: 'PATCH',
    body,
  });
}

export async function listDomains(
  storeId: string,
): Promise<ApiResult<AdminResponse<'listDomains'>>> {
  return adminCall<'listDomains'>({
    path: buildPath('/admin/stores/{storeId}/domains', { storeId }),
  });
}

export async function addDomain(
  storeId: string,
  body: { hostname: string; is_primary?: boolean },
): Promise<ApiResult<AdminResponse<'addDomain'>>> {
  return adminCall<'addDomain'>({
    path: buildPath('/admin/stores/{storeId}/domains', { storeId }),
    method: 'POST',
    body,
  });
}

export async function listSalesChannels(
  storeId: string,
): Promise<ApiResult<AdminResponse<'listSalesChannels'>>> {
  return adminCall<'listSalesChannels'>({
    path: buildPath('/admin/stores/{storeId}/sales-channels', { storeId }),
  });
}

export async function createSalesChannel(
  storeId: string,
  body: { code: string; name: string; type: string },
): Promise<ApiResult<AdminResponse<'createSalesChannel'>>> {
  return adminCall<'createSalesChannel'>({
    path: buildPath('/admin/stores/{storeId}/sales-channels', { storeId }),
    method: 'POST',
    body,
  });
}

export async function listApiKeys(
  storeId: string,
): Promise<ApiResult<AdminResponse<'listApiKeys'>>> {
  return adminCall<'listApiKeys'>({
    path: buildPath('/admin/stores/{storeId}/api-keys', { storeId }),
  });
}

/**
 * Returns the plain key **exactly once** — the response carries `key`, and no later read can get it
 * back. Whatever calls this must hand that value to the user immediately and never persist it.
 */
export async function createApiKey(
  storeId: string,
  body: { name: string; type: string; sales_channel_id?: string },
): Promise<ApiResult<AdminResponse<'createApiKey'>>> {
  return adminCall<'createApiKey'>({
    path: buildPath('/admin/stores/{storeId}/api-keys', { storeId }),
    method: 'POST',
    body,
  });
}

export async function listLegalEntities(): Promise<ApiResult<AdminResponse<'listLegalEntities'>>> {
  return adminCall<'listLegalEntities'>({ path: '/admin/legal-entities' });
}

export async function listWarehouses(): Promise<ApiResult<AdminResponse<'listWarehouses'>>> {
  return adminCall<'listWarehouses'>({ path: '/admin/warehouses' });
}

// ---------------------------------------------------------------------------- catalog

export async function listCategories(
  storeId: string,
): Promise<ApiResult<AdminResponse<'listCategories'>>> {
  return adminCall<'listCategories'>({
    path: buildPath('/admin/stores/{storeId}/categories', { storeId }),
  });
}

export async function createCategory(
  storeId: string,
  body: AdminComponents['CategoryInput'],
): Promise<ApiResult<AdminResponse<'createCategory'>>> {
  return adminCall<'createCategory'>({
    path: buildPath('/admin/stores/{storeId}/categories', { storeId }),
    method: 'POST',
    body,
  });
}

/** Filterable by `q`, `status` and `category_id`; sortable by title/handle/status/created/updated. */
export async function listProducts(
  storeId: string,
  query: Query,
): Promise<ApiResult<AdminResponse<'listProducts'>>> {
  return adminCall<'listProducts'>({
    path: buildPath('/admin/stores/{storeId}/products', { storeId }),
    query,
  });
}

export async function createProduct(
  storeId: string,
  body: AdminComponents['ProductInput'],
): Promise<ApiResult<AdminResponse<'createProduct'>>> {
  return adminCall<'createProduct'>({
    path: buildPath('/admin/stores/{storeId}/products', { storeId }),
    method: 'POST',
    body,
  });
}

export async function getProduct(
  storeId: string,
  productId: string,
): Promise<ApiResult<AdminResponse<'getProduct'>>> {
  return adminCall<'getProduct'>({
    path: buildPath('/admin/stores/{storeId}/products/{productId}', { storeId, productId }),
  });
}

export async function updateProduct(
  storeId: string,
  productId: string,
  body: AdminComponents['ProductInput'],
): Promise<ApiResult<AdminResponse<'updateProduct'>>> {
  return adminCall<'updateProduct'>({
    path: buildPath('/admin/stores/{storeId}/products/{productId}', { storeId, productId }),
    method: 'PATCH',
    body,
  });
}

/** Emits `product.published`; the response carries the new `status` and `published_at`. */
export async function publishProduct(
  storeId: string,
  productId: string,
): Promise<ApiResult<AdminResponse<'publishProduct'>>> {
  return adminCall<'publishProduct'>({
    path: buildPath('/admin/stores/{storeId}/products/{productId}/publish', { storeId, productId }),
    method: 'POST',
  });
}

/** Archive, never hard-delete (contract summary). Answers `204`, so there is no body. */
export async function archiveProduct(
  storeId: string,
  productId: string,
): Promise<ApiResult<AdminResponse<'archiveProduct'>>> {
  return adminCall<'archiveProduct'>({
    path: buildPath('/admin/stores/{storeId}/products/{productId}', { storeId, productId }),
    method: 'DELETE',
  });
}

export async function createVariant(
  storeId: string,
  productId: string,
  body: AdminComponents['VariantInput'],
): Promise<ApiResult<AdminResponse<'createVariant'>>> {
  return adminCall<'createVariant'>({
    path: buildPath('/admin/stores/{storeId}/products/{productId}/variants', {
      storeId,
      productId,
    }),
    method: 'POST',
    body,
  });
}

export async function updateVariant(
  storeId: string,
  variantId: string,
  body: AdminComponents['VariantInput'],
): Promise<ApiResult<AdminResponse<'updateVariant'>>> {
  return adminCall<'updateVariant'>({
    path: buildPath('/admin/stores/{storeId}/variants/{variantId}', { storeId, variantId }),
    method: 'PATCH',
    body,
  });
}
