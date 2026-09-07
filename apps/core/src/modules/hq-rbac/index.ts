// Public API of the hq-rbac module (window 2). The core imports only from here.
// Task 1.3: role/tuple management routes. Task 1.4: staff scope middleware. Task 1.5: GET /admin/audit-log.
export { createHqRbac, HQ_RBAC_ROUTES } from './http.js';
export type { HqRbacDeps, HqRbacRequest, HqRbacResponse, HqRbacRoute, Permission } from './http.js';
export { createStaffScopeMiddleware } from './scope.js';
export type { StaffScopeMiddleware, StaffScopeMiddlewareDeps } from './scope.js';
// Re-exported so the core needs no second import for the scope → tenant-context step.
export { toTenantContext, ScopeCache } from '@platform/auth-sdk';
export type { StaffScope } from '@platform/auth-sdk';
