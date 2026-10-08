// Keycloak admin API client for the staff realm (issue #415, task 3.1b/c). The core authenticates as the
// confidential service-account client `core-admin` (client-credentials grant; realm-management roles
// manage-users, view-users, query-users — nothing else), never with a user's password. Credentials come
// from the environment: KEYCLOAK_ADMIN_CLIENT_ID (default core-admin) and KEYCLOAK_ADMIN_CLIENT_SECRET (the dev
// realm export carries the dev-only value, listed in infra/keycloak/README.md's dev-only table; production
// gets its own from Vault, see #416). Every failure maps to the contract's error body: 409 when the user
// exists, 503 (fail closed) when Keycloak is unreachable or refuses the service account.
import { ApiError } from '../types.js';

export interface KeycloakAdminOptions {
  /** Keycloak base URL; default `KEYCLOAK_URL` or http://localhost:8180. */
  baseUrl?: string;
  /** Staff realm; default `KEYCLOAK_REALM_STAFF` or `staff`. */
  realm?: string;
  /** Default `KEYCLOAK_ADMIN_CLIENT_ID` or `core-admin`. */
  clientId?: string;
  /** Default `KEYCLOAK_ADMIN_CLIENT_SECRET`. Required: no secret → 503 on first use, never a silent fallback. */
  clientSecret?: string;
  /** Per-request timeout (ms), default 10 000. */
  timeoutMs?: number;
}

export interface CreateStaffUserInput {
  /** Also the username (the staff realm keeps `email = username`). */
  email: string;
  /**
   * Split into Keycloak `firstName` (first word) and `lastName` (the rest; a one-word name is stored as both):
   * the realm's user profile requires both, and an account missing one is "not fully set up" — no token,
   * not even through the direct grant (measured 2026-10-08). The token's `name` claim shows both.
   */
  displayName: string;
}

export interface KeycloakStaffUser {
  /** Keycloak user id = `staff_user.keycloak_subject` = the token's `sub`. */
  subject: string;
  username: string;
  email: string;
  enabled: boolean;
  emailVerified: boolean;
  firstName: string;
  lastName: string;
  requiredActions: string[];
}

export interface KeycloakUserSession {
  id: string;
  start: number;
  lastAccess: number;
  clients: Record<string, string>;
}

/** The required actions every invited staff user starts with: set a password, enrol TOTP (ADR 0002 MFA). */
export const INVITE_REQUIRED_ACTIONS = ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'] as const;

export interface KeycloakAdmin {
  readonly realm: string;
  /** Creates the user with no password and the invite required actions. 409 when the email/username exists. */
  createUser(input: CreateStaffUserInput): Promise<KeycloakStaffUser>;
  getUser(subject: string): Promise<KeycloakStaffUser | null>;
  /** Ends every session of the user (admin `logout`): refresh tokens die; access tokens expire by `exp`. */
  logoutUser(subject: string): Promise<void>;
  listUserSessions(subject: string): Promise<KeycloakUserSession[]>;
  /** Tests clean up their throwaway users with it; the core never deletes staff users (status = disabled). */
  deleteUser(subject: string): Promise<void>;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createKeycloakAdmin(opts: KeycloakAdminOptions = {}): KeycloakAdmin {
  const baseUrl = (opts.baseUrl ?? process.env.KEYCLOAK_URL ?? 'http://localhost:8180').replace(
    /\/+$/,
    '',
  );
  const realm = opts.realm ?? process.env.KEYCLOAK_REALM_STAFF ?? 'staff';
  const clientId = opts.clientId ?? process.env.KEYCLOAK_ADMIN_CLIENT_ID ?? 'core-admin';
  const clientSecret = opts.clientSecret ?? process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const adminUrl = `${baseUrl}/admin/realms/${realm}`;

  const unavailable = (what: string, cause: unknown): ApiError =>
    new ApiError(503, 'internal', 'identity provider unavailable', {
      what,
      cause: cause instanceof Error ? cause.message : String(cause),
    });

  let token: { value: string; expiresAt: number } | undefined;
  async function bearer(): Promise<string> {
    if (token && token.expiresAt - Date.now() > 30_000) return token.value;
    if (!clientSecret) {
      throw new ApiError(503, 'internal', 'identity provider unavailable', {
        what: 'service account',
        cause: 'KEYCLOAK_ADMIN_CLIENT_SECRET is not set',
      });
    }
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/realms/${realm}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw unavailable('service account token', err);
    }
    const json = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || !json.access_token) {
      // Wrong secret, disabled client, missing roles: an operator problem, never the caller's → 503.
      throw unavailable('service account token', `${res.status} ${json.error ?? ''}`.trim());
    }
    token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 60) * 1000 };
    return json.access_token;
  }

  async function call(
    what: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${await bearer()}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await fetch(`${adminUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw unavailable(what, err);
    }
  }

  const toUser = (u: Record<string, unknown>): KeycloakStaffUser => ({
    subject: String(u.id),
    username: String(u.username ?? ''),
    email: String(u.email ?? ''),
    enabled: u.enabled === true,
    emailVerified: u.emailVerified === true,
    firstName: String(u.firstName ?? ''),
    lastName: String(u.lastName ?? ''),
    requiredActions: Array.isArray(u.requiredActions) ? (u.requiredActions as string[]) : [],
  });

  async function getUser(subject: string): Promise<KeycloakStaffUser | null> {
    const res = await call('read user', 'GET', `/users/${encodeURIComponent(subject)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw unavailable('read user', `${res.status}`);
    return toUser((await res.json()) as Record<string, unknown>);
  }

  return {
    realm,
    async createUser(input) {
      const email = input.email.trim().toLowerCase();
      const displayName = input.displayName.trim();
      if (!EMAIL.test(email)) {
        throw new ApiError(400, 'validation_error', 'email must be an address', { field: 'email' });
      }
      if (!displayName) {
        throw new ApiError(400, 'validation_error', 'display_name is required', {
          field: 'display_name',
        });
      }
      const [firstName, ...rest] = displayName.split(/\s+/);
      const lastName = rest.length > 0 ? rest.join(' ') : firstName!;
      const res = await call('create user', 'POST', '/users', {
        username: email,
        email,
        enabled: true,
        emailVerified: false,
        firstName,
        lastName,
        requiredActions: [...INVITE_REQUIRED_ACTIONS],
      });
      if (res.status === 409) {
        throw new ApiError(409, 'conflict', 'a staff user with this email already exists', {
          field: 'email',
        });
      }
      if (res.status !== 201) throw unavailable('create user', `${res.status}`);
      const location = res.headers.get('location') ?? '';
      const subject = location.slice(location.lastIndexOf('/') + 1);
      if (!subject) throw unavailable('create user', 'no Location header');
      const user = await getUser(subject);
      if (!user) throw unavailable('create user', 'created user not readable');
      return user;
    },
    getUser,
    async logoutUser(subject) {
      const res = await call('logout user', 'POST', `/users/${encodeURIComponent(subject)}/logout`);
      if (res.status !== 204 && res.status !== 404)
        throw unavailable('logout user', `${res.status}`);
    },
    async listUserSessions(subject) {
      const res = await call(
        'list sessions',
        'GET',
        `/users/${encodeURIComponent(subject)}/sessions`,
      );
      if (!res.ok) throw unavailable('list sessions', `${res.status}`);
      return (await res.json()) as KeycloakUserSession[];
    },
    async deleteUser(subject) {
      const res = await call('delete user', 'DELETE', `/users/${encodeURIComponent(subject)}`);
      if (res.status !== 204 && res.status !== 404)
        throw unavailable('delete user', `${res.status}`);
    },
  };
}
