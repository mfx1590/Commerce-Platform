// Cross-cutting HTTP layer of apps/core: everything src/server.ts mounts ahead of Medusa, and what route files use.
import './types';

export { aliasPublishableKeyHeader } from './publishable-key-alias';
export { requestIdMiddleware, requestIdOf } from './request-id';
export { CONTRACTS_VERSION_HEADER, contractsVersionHeader } from './contracts-version';
export { adminNotFound, coreErrorHandler, handle } from './errors';
export {
  coreOrganizationId,
  requireTenant,
  resolveStoreContext,
  storeContextMiddleware,
} from './tenant';
export type { StoreContext } from './tenant';
export {
  composeStaffTokenVerifier,
  DEV_TOKENS_FLAG,
  devTokensEnabled,
  DevTokenVerifier,
  hasOrganizationAccess,
  KeycloakStaffTokenVerifier,
  organizationClientFor,
  parseBearer,
  principalScope,
  requirePrincipal,
  resolveStaffPrincipal,
  staffAuthMiddleware,
  storeClientFor,
  visibleStoreIds,
  visibleStoresClientFor,
} from './staff-auth';
export type {
  KeycloakStaffTokenVerifierOptions,
  PrincipalStore,
  StaffIdentity,
  StaffPrincipal,
  StaffTokenVerifier,
} from './staff-auth';
export { hqRbacAdapter } from './hq-rbac-adapter';
export type { HqRbacAdapterOptions } from './hq-rbac-adapter';
export { STORE_API_FALLBACK_ENV, storeApiFallbackProxy } from './store-fallback';
export type { StoreApiFallbackOptions } from './store-fallback';
export {
  addLineItemRoute,
  completeCartRoute,
  createCartRoute,
  createPaymentSessionRoute,
  getCartRoute,
  getOrderRoute,
  listShippingOptionsRoute,
  getProductRoute,
  getStoreRoute,
  listCategoriesRoute,
  listProductsRoute,
  mountStoreRoutes,
  REAL_STORE_PATHS,
  removeLineItemRoute,
  resolveCurrency,
  paymentMethodsOf,
  storeSummary,
  updateCartRoute,
  updateLineItemRoute,
} from './store-routes';
// Nothing that ACCEPTS a customer token verifier is exported here except through mountStoreRoutes: the route
// factories (`mountCustomerRoutes`, `getOrderRouteWith`, `requireCustomer`) stay inside src/http.
export {
  CUSTOMER_STORE_PATHS,
  customerTokenVerifierFor,
  keycloakCustomerTokenVerifier,
} from './customer-routes';
export type { CustomerTokenVerifier } from './customer-routes';
export { adminRouter } from './admin-routes';
export { moduleAdminRouters, moduleWebhookRouters } from './module-routers';
export { loadSpec, openApiDir } from './openapi';
export type { Spec, SpecFile } from './openapi';
export {
  assertPermission,
  can,
  ensurePermission,
  hasPermission,
  requirePermission,
  resolveObject,
} from './permissions';
export type {
  ObjectFactory,
  Permission,
  PermissionObject,
  PermissionRelation,
} from './permissions';
export {
  dateParam,
  enumParam,
  intParam,
  one,
  pageParams,
  sortParams,
  throwIfProblems,
  uuidParam,
} from './query';
