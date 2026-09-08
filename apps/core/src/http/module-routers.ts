// Admin API routers other windows' modules export from their index.ts (hq-rbac lesson: a module is not done
// until something mounts it — this is the named mount point). Mounted by mountCoreMiddleware right after
// adminRouter(), so they get the same staff principal, JSON body parser and error handler, and their routes
// must run the spec's x-permission through requirePermission themselves (or through the router they build).
//
// Window 9 (search, issue #162 part 3): once search 2.2 lands, add
//   import { merchandisingRouter } from '../modules/search';
//   routers.push(merchandisingRouter({ repository, indexFor }));
// with the repository/indexFor the search README documents. Until then the list is empty and the routes are
// proven by the module's own tests on a bare Express app.
import type { Router } from 'express';

export function moduleAdminRouters(): Router[] {
  const routers: Router[] = [];
  return routers;
}
