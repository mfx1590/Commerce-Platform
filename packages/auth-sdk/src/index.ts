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

// JWT verification + scope resolution (ADR 0002 §4).
export { createStaffTokenVerifier, bearerToken } from './jwt/verify.js';
export type { StaffTokenVerifier, StaffTokenVerifierOptions, StaffClaims } from './jwt/verify.js';
export {
  resolveRelations,
  toTenantContext,
  ScopeCache,
  ORGANIZATION_RELATIONS,
  SCOPE_CACHE_MAX_TTL_MS,
} from './scope/resolve.js';
export type { StaffScope, ResolveScopeInput } from './scope/resolve.js';

// Audit log: PII redaction and the read side of GET /admin/audit-log.
export { redactPii, PII_FIELDS, REDACTED } from './audit/redact.js';
export { listAuditLog } from './audit/read.js';
export type { AuditLogFilters, AuditLogEntry, AuditLogPage } from './audit/read.js';
