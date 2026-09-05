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
  DevTokenVerifier,
  hasOrganizationAccess,
  organizationClientFor,
  parseBearer,
  requirePrincipal,
  resolveStaffPrincipal,
  staffAuthMiddleware,
  storeClientFor,
  visibleStoresClientFor,
} from './staff-auth';
export type {
  PrincipalStore,
  StaffIdentity,
  StaffPrincipal,
  StaffTokenVerifier,
} from './staff-auth';
export {
  getProductRoute,
  getStoreRoute,
  listCategoriesRoute,
  listProductsRoute,
  mountStoreRoutes,
  storeSummary,
} from './store-routes';
