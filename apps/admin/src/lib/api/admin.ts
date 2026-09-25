/**
 * Server-side entry point to the Admin API: binds the transport to the configured base URL and the
 * signed-in principal's access token.
 *
 * Adding a screen means adding a typed wrapper here, never calling `fetch` from a component. The
 * type parameter is the contract `operationId`, so `AdminResponse<'listProducts'>` is exactly the
 * response body `admin-api.yaml` documents and a contract rename breaks the build.
 *
 * Contract: Admin API 0.4.0.
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

// ---------------------------------------------------------------------------- orders (task 2.2)

/**
 * Filterable by `status`, `payment_status`, `fulfillment_status`, `q` (display id or email) and
 * `placed_from` / `placed_to`; sortable by placed_at / display_id / total / status.
 */
export async function listOrders(
  storeId: string,
  query: Query,
): Promise<ApiResult<AdminResponse<'listOrders'>>> {
  return adminCall<'listOrders'>({
    path: buildPath('/admin/stores/{storeId}/orders', { storeId }),
    query,
  });
}

export async function getOrder(
  storeId: string,
  orderId: string,
): Promise<ApiResult<AdminResponse<'getOrder'>>> {
  return adminCall<'getOrder'>({
    path: buildPath('/admin/stores/{storeId}/orders/{orderId}', { storeId, orderId }),
  });
}

/** Cancels an unshipped order: releases stock, voids or refunds the payment, emits `order.cancelled`. */
export async function cancelOrder(
  storeId: string,
  orderId: string,
  body: { reason: string },
): Promise<ApiResult<AdminResponse<'cancelOrder'>>> {
  return adminCall<'cancelOrder'>({
    path: buildPath('/admin/stores/{storeId}/orders/{orderId}/cancel', { storeId, orderId }),
    method: 'POST',
    body,
  });
}

/** Lowers a line's quantity before fulfilment; totals are recomputed, no money moves. */
export async function updateOrderLineItem(
  storeId: string,
  orderId: string,
  lineItemId: string,
  body: { quantity: number },
): Promise<ApiResult<AdminResponse<'updateOrderLineItem'>>> {
  return adminCall<'updateOrderLineItem'>({
    path: buildPath('/admin/stores/{storeId}/orders/{orderId}/line-items/{lineItemId}', {
      storeId,
      orderId,
      lineItemId,
    }),
    method: 'PATCH',
    body,
  });
}

/** Cancels one line before fulfilment; the contract refuses the last line (cancel the order). */
export async function cancelOrderLineItem(
  storeId: string,
  orderId: string,
  lineItemId: string,
): Promise<ApiResult<AdminResponse<'cancelOrderLineItem'>>> {
  return adminCall<'cancelOrderLineItem'>({
    path: buildPath('/admin/stores/{storeId}/orders/{orderId}/line-items/{lineItemId}', {
      storeId,
      orderId,
      lineItemId,
    }),
    method: 'DELETE',
  });
}

/**
 * Refunds part or all of a captured payment. The contract requires an `Idempotency-Key` header
 * (min 8 chars): the caller mints it once per attempt and re-sends the same key on a retry, so a
 * request that timed out after the provider acted cannot refund twice.
 */
export async function createRefund(
  storeId: string,
  orderId: string,
  idempotencyKey: string,
  body: {
    payment_id?: string;
    amount_minor: number;
    reason: 'return' | 'cancellation' | 'goodwill' | 'chargeback';
    return_id?: string;
  },
): Promise<ApiResult<AdminResponse<'createRefund'>>> {
  return adminCall<'createRefund'>({
    path: buildPath('/admin/stores/{storeId}/orders/{orderId}/refunds', { storeId, orderId }),
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body,
  });
}

export async function createReturn(
  storeId: string,
  orderId: string,
  body: { reason?: string; items: { order_line_item_id: string; quantity: number }[] },
): Promise<ApiResult<AdminResponse<'createReturn'>>> {
  return adminCall<'createReturn'>({
    path: buildPath('/admin/stores/{storeId}/orders/{orderId}/returns', { storeId, orderId }),
    method: 'POST',
    body,
  });
}

/** Warehouse received the goods (emits `return.received`, `stock.moved`); `operations` on HQ. */
export async function receiveReturn(
  storeId: string,
  returnId: string,
  body: {
    warehouse_id: string;
    items: { order_line_item_id: string; quantity: number; condition: 'resellable' | 'damaged' }[];
  },
): Promise<ApiResult<AdminResponse<'receiveReturn'>>> {
  return adminCall<'receiveReturn'>({
    path: buildPath('/admin/stores/{storeId}/returns/{returnId}/receive', { storeId, returnId }),
    method: 'POST',
    body,
  });
}

// ---------------------------------------------------------------------------- fulfillment (task 2.2)

/** Plans a shipment from a warehouse for some or all lines (emits `shipment.created`). */
export async function createShipment(
  storeId: string,
  orderId: string,
  body: {
    warehouse_id: string;
    carrier?: string;
    service?: string;
    items: { order_line_item_id: string; quantity: number }[];
  },
): Promise<ApiResult<AdminResponse<'createShipment'>>> {
  return adminCall<'createShipment'>({
    path: buildPath('/admin/stores/{storeId}/orders/{orderId}/shipments', { storeId, orderId }),
    method: 'POST',
    body,
  });
}

/** Advances a shipment's status and/or attaches tracking and label. Not store-scoped in the contract. */
export async function updateShipment(
  shipmentId: string,
  body: {
    status?: 'label_created' | 'shipped' | 'in_transit' | 'delivered' | 'failed' | 'cancelled';
    tracking_number?: string;
    tracking_url?: string;
    label_url?: string;
    cost_minor?: number;
  },
): Promise<ApiResult<AdminResponse<'updateShipment'>>> {
  return adminCall<'updateShipment'>({
    path: buildPath('/admin/shipments/{shipmentId}', { shipmentId }),
    method: 'PATCH',
    body,
  });
}

/** Starts picking a planned shipment (emits `fulfillment.picking`). */
export async function pickShipment(
  shipmentId: string,
): Promise<ApiResult<AdminResponse<'pickShipment'>>> {
  return adminCall<'pickShipment'>({
    path: buildPath('/admin/shipments/{shipmentId}/pick', { shipmentId }),
    method: 'POST',
  });
}

/** Marks a picked shipment packed and ready for the carrier (emits `fulfillment.packed`). */
export async function packShipment(
  shipmentId: string,
  body: { parcel_count?: number } = {},
): Promise<ApiResult<AdminResponse<'packShipment'>>> {
  return adminCall<'packShipment'>({
    path: buildPath('/admin/shipments/{shipmentId}/pack', { shipmentId }),
    method: 'POST',
    body,
  });
}

/** Shipments waiting to be picked or packed, grouped by warehouse; filter by warehouse/status. */
export async function listPickLists(
  storeId: string,
  query: Query,
): Promise<ApiResult<AdminResponse<'listPickLists'>>> {
  return adminCall<'listPickLists'>({
    path: buildPath('/admin/stores/{storeId}/pick-lists', { storeId }),
    query,
  });
}

// ---------------------------------------------------------------------------- customers (task 2.3)

/** `support` on the store (Admin API 0.2.1+): customer records are personal data. Filter `q`, `group_id`; sort created_at/email/last_name. */
export async function listCustomers(
  storeId: string,
  query: Query,
): Promise<ApiResult<AdminResponse<'listCustomers'>>> {
  return adminCall<'listCustomers'>({
    path: buildPath('/admin/stores/{storeId}/customers', { storeId }),
    query,
  });
}

export async function getCustomer(
  storeId: string,
  customerId: string,
): Promise<ApiResult<AdminResponse<'getCustomer'>>> {
  return adminCall<'getCustomer'>({
    path: buildPath('/admin/stores/{storeId}/customers/{customerId}', { storeId, customerId }),
  });
}

export async function updateCustomer(
  storeId: string,
  customerId: string,
  body: {
    first_name?: string;
    last_name?: string;
    phone?: string;
    customer_group_id?: string | null;
    status?: 'registered' | 'disabled';
  },
): Promise<ApiResult<AdminResponse<'updateCustomer'>>> {
  return adminCall<'updateCustomer'>({
    path: buildPath('/admin/stores/{storeId}/customers/{customerId}', { storeId, customerId }),
    method: 'PATCH',
    body,
  });
}

/**
 * GDPR erasure: anonymises the PII, keeps the order financials, emits `customer.erased`. Answers
 * `202` with no body (REQUEST #251 made that type as `null` rather than lie), so the caller
 * re-reads to show the new `status: erased`.
 */
export async function eraseCustomer(
  storeId: string,
  customerId: string,
): Promise<ApiResult<AdminResponse<'eraseCustomer'>>> {
  return adminCall<'eraseCustomer'>({
    path: buildPath('/admin/stores/{storeId}/customers/{customerId}/erase', {
      storeId,
      customerId,
    }),
    method: 'POST',
  });
}
