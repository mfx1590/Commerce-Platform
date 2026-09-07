// Shared types: the staff principal a request carries and the error shape of packages/contracts (`Error`).

/** A verified staff identity, resolved by the scope middleware (hq-rbac, task 1.4). */
export interface StaffPrincipal {
  /** `staff_user.id` — the OpenFGA `user:<id>` and the `role_assignment.staff_user_id`. */
  userId: string;
  /** Keycloak `sub` (`staff_user.keycloak_subject`). */
  subject: string;
  organizationId: string;
  email?: string;
}

export type ErrorCode =
  'validation_error' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'internal';

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details: Record<string, unknown>;
}

/** Thrown by SDK/service code; HTTP layers turn it into `{ code, message, details }` with `status`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
  toBody(): ErrorBody {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/** 403 exactly as `packages/contracts` documents it: `requires <relation> on <object>`. */
export function forbidden(relation: string, object: string): ApiError {
  return new ApiError(403, 'forbidden', `requires ${relation} on ${object}`, { relation, object });
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;
