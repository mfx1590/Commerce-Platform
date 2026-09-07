// Public API of @platform/auth-sdk. Nothing outside this package may import from src/* directly.
export const PACKAGE_NAME = '@platform/auth-sdk' as const;

// Types shared with hq-rbac and the core.
export { ApiError, forbidden, isApiError } from './types.js';
export type { StaffPrincipal, ErrorBody, ErrorCode } from './types.js';
export { RELATIONS } from '@platform/contracts';
export type { Relation } from '@platform/contracts';
export type { OpenFgaClient, TupleKey } from '@openfga/sdk';

// OpenFGA: model + seed helpers (infra/openfga) and the client factory.
export {
  OPENFGA_DIR,
  loadAuthorizationModel,
  loadSeedTuples,
  modelFromDsl,
  readModelDsl,
} from './fga/model.js';
export { createOpenFgaClient, DEFAULT_OPENFGA_API_URL } from './fga/client.js';
export type { OpenFgaClientOptions } from './fga/client.js';
export { seedOpenFga, DEFAULT_OPENFGA_STORE_NAME } from './fga/seed.js';
export type { SeedOpenFgaOptions, SeedOpenFgaResult } from './fga/seed.js';

// Audit writer (append-only, same transaction as the change).
export { audit } from './audit/write.js';
export type { AuditEntry, AuditActorType } from './audit/write.js';

// Role / tuple management (ADR 0002 §7).
export {
  assignRole,
  revokeRole,
  listRoleAssignments,
  listStaffUsers,
  validateAssignment,
  ASSIGNABLE_RELATIONS,
  OBJECT_TYPES,
  isUuid,
} from './roles/service.js';
export type {
  RolesDeps,
  AssignRoleInput,
  RoleAssignment,
  StaffUser,
  ObjectType,
} from './roles/service.js';
