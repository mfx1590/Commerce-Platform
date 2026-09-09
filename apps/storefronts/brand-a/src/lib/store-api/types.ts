/**
 * Types for the Store API, derived from `@platform/contracts/store` (generated from
 * `openapi/store-api.yaml`, frozen at contracts-v0.1). Nothing here is hand-written data: if the
 * contract changes, these aliases change with it and the compiler points at every call site.
 */
import type { components, operations } from '@platform/contracts/store';

export type Schemas = components['schemas'];

export type ApiErrorBody = Schemas['Error'];
export type Money = Schemas['Money'];
export type Address = Schemas['Address'];
export type Store = Schemas['Store'];
export type Category = Schemas['Category'];
export type ProductSummary = Schemas['ProductSummary'];
export type Product = Schemas['Product'];
export type Variant = Schemas['Variant'];
export type LineItem = Schemas['LineItem'];
export type Totals = Schemas['Totals'];
export type ShippingOption = Schemas['ShippingOption'];
export type PaymentSession = Schemas['PaymentSession'];
export type Cart = Schemas['Cart'];
export type OrderSummary = Schemas['OrderSummary'];
export type Order = Schemas['Order'];
export type Customer = Schemas['Customer'];
export type CustomerAddress = Schemas['CustomerAddress'];

export type OperationId = keyof operations;

type JsonBody<T> = T extends { content: { 'application/json': infer B } } ? B : never;

/** The success body of an operation (200, else 201), or `void` when it returns no JSON. */
export type Result<K extends OperationId> = operations[K]['responses'] extends {
  200: infer R;
}
  ? JsonBody<R>
  : operations[K]['responses'] extends { 201: infer R }
    ? JsonBody<R>
    : void;

/** The query string parameters of an operation. */
export type Query<K extends OperationId> = operations[K] extends {
  parameters: { query?: infer Q };
}
  ? NonNullable<Q>
  : never;

/** The JSON request body of an operation. */
export type Body<K extends OperationId> = operations[K] extends { requestBody?: infer R }
  ? JsonBody<NonNullable<R>>
  : never;

export type ProductPage = Result<'listProducts'>;
export type OrderPage = Result<'listMyOrders'>;
export type ListProductsQuery = Query<'listProducts'>;
