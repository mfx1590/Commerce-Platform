// Public API of the hq-rbac module (window 2). The core imports only from here.
// Task 1.3: role/tuple management routes. Task 1.4 adds the scope middleware, 1.5 GET /admin/audit-log.
export { createHqRbac, HQ_RBAC_ROUTES } from './http.js';
export type { HqRbacDeps, HqRbacRequest, HqRbacResponse, HqRbacRoute, Permission } from './http.js';
