// Cross-cutting HTTP layer of apps/core: everything src/server.ts mounts ahead of Medusa, and what route files use.
import './types';

export { aliasPublishableKeyHeader } from './publishable-key-alias';
export { requestIdMiddleware, requestIdOf } from './request-id';
export { coreErrorHandler, handle } from './errors';
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
  getProductRoute,
  getStoreRoute,
  listCategoriesRoute,
  listProductsRoute,
  mountStoreRoutes,
  storeSummary,
} from './store-routes';
export { adminRouter } from './admin-routes';
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
export { intParam, one, pageParams, throwIfProblems, uuidParam } from './query';
