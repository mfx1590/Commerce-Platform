// Keycloak realm exports (infra/keycloak, issue #10).
// Static part: always runs, validates the JSON files against the seed contract and the security rules.
// Live part: runs only when the local Keycloak (KEYCLOAK_URL, default http://localhost:8180) answers.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED_IDS } from '@platform/db';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const realmDir = resolve(here, '../../../infra/keycloak');

interface Mapper {
  name: string;
  protocolMapper: string;
  config: Record<string, string>;
}
interface Client {
  clientId: string;
  publicClient?: boolean;
  secret?: string;
  standardFlowEnabled?: boolean;
  directAccessGrantsEnabled?: boolean;
  attributes?: Record<string, string>;
  protocolMappers?: Mapper[];
}
interface Execution {
  authenticator?: string;
  flowAlias?: string;
  requirement: string;
  priority: number;
}
interface Flow {
  alias: string;
  topLevel: boolean;
  authenticationExecutions: Execution[];
}
interface User {
  id: string;
  username: string;
  email: string;
  requiredActions?: string[];
  credentials?: { type: string; value?: string }[];
}
interface Realm {
  realm: string;
  registrationAllowed: boolean;
  resetPasswordAllowed: boolean;
  bruteForceProtected: boolean;
  browserFlow?: string;
  otpPolicyType?: string;
  authenticationFlows?: Flow[];
  identityProviders?: { alias: string; enabled: boolean; config: Record<string, string> }[];
  clients: Client[];
  users: User[];
}

const staff = JSON.parse(readFileSync(resolve(realmDir, 'staff-realm.json'), 'utf8')) as Realm;
const customers = JSON.parse(
  readFileSync(resolve(realmDir, 'customers-realm.json'), 'utf8'),
) as Realm;

const client = (realm: Realm, id: string): Client => {
  const c = realm.clients.find((x) => x.clientId === id);
  if (!c) throw new Error(`client ${id} missing in realm ${realm.realm}`);
  return c;
};
const mapperClaims = (c: Client) =>
  (c.protocolMappers ?? []).map((m) => m.config['claim.name'] ?? m.name);
const kebab = (s: string) => s.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
/** Seeded staff usernames, derived from SEED_IDS.users keys the same way packages/db derives keycloak_subject. */
const seededUsernames = Object.keys(SEED_IDS.users).map(kebab).sort();

describe('staff realm export (static)', () => {
  it('mirrors SEED_IDS.users: username, email and id == staff_user.keycloak_subject', () => {
    const usernames = staff.users.map((u) => u.username).sort();
    expect(usernames).toEqual(seededUsernames);
    for (const u of staff.users) {
      expect(u.id).toBe(`seed-${u.username}`);
      expect(u.email).toBe(`${u.username}@example.com`);
      expect(u.requiredActions ?? []).toEqual([]);
    }
  });

  it('enforces MFA through the browser flow (TOTP REQUIRED, not conditional)', () => {
    expect(staff.browserFlow).toBe('browser-mfa');
    expect(staff.otpPolicyType).toBe('totp');
    const top = staff.authenticationFlows?.find((f) => f.alias === 'browser-mfa');
    const forms = staff.authenticationFlows?.find((f) => f.alias === 'browser-mfa forms');
    expect(top?.topLevel).toBe(true);
    expect(top?.authenticationExecutions.map((e) => e.flowAlias ?? e.authenticator)).toEqual([
      'auth-cookie',
      'identity-provider-redirector',
      'browser-mfa forms',
    ]);
    const otp = forms?.authenticationExecutions.find((e) => e.authenticator === 'auth-otp-form');
    const pwd = forms?.authenticationExecutions.find(
      (e) => e.authenticator === 'auth-username-password-form',
    );
    expect(pwd?.requirement).toBe('REQUIRED');
    expect(otp?.requirement).toBe('REQUIRED');
    expect(otp!.priority).toBeGreaterThan(pwd!.priority);
  });

  it('admin-app is a public PKCE client without password grant and carries email + audience', () => {
    const app = client(staff, 'admin-app');
    expect(app.publicClient).toBe(true);
    expect(app.standardFlowEnabled).toBe(true);
    expect(app.directAccessGrantsEnabled).toBe(false);
    expect(app.attributes?.['pkce.code.challenge.method']).toBe('S256');
    expect(mapperClaims(app)).toEqual(
      expect.arrayContaining(['email', 'email_verified', 'preferred_username']),
    );
    const aud = app.protocolMappers?.find((m) => m.protocolMapper === 'oidc-audience-mapper');
    expect(aud?.config['included.custom.audience']).toBe('core-api');
  });

  it('test-cli is the only client with the password grant', () => {
    const withGrant = staff.clients
      .filter((c) => c.directAccessGrantsEnabled)
      .map((c) => c.clientId);
    expect(withGrant).toEqual(['test-cli']);
    expect(client(staff, 'test-cli').standardFlowEnabled).toBe(false);
    expect(mapperClaims(client(staff, 'test-cli'))).toContain('email');
  });

  it('registration is closed and brute-force protection is on', () => {
    expect(staff.registrationAllowed).toBe(false);
    expect(staff.bruteForceProtected).toBe(true);
  });
});

describe('customers realm export (static)', () => {
  it('allows registration and password reset', () => {
    expect(customers.registrationAllowed).toBe(true);
    expect(customers.resetPasswordAllowed).toBe(true);
    expect(customers.bruteForceProtected).toBe(true);
  });

  it.each(['brand-a', 'brand-b', 'brand-c'])(
    'has a public PKCE client for %s stamping store_code',
    (code) => {
      const c = client(customers, `storefront-${code}`);
      expect(c.publicClient).toBe(true);
      expect(c.directAccessGrantsEnabled).toBe(false);
      expect(c.attributes?.['pkce.code.challenge.method']).toBe('S256');
      const storeCode = c.protocolMappers?.find((m) => m.config['claim.name'] === 'store_code');
      expect(storeCode?.config['claim.value']).toBe(code);
      expect(mapperClaims(c)).toContain('email');
    },
  );

  it('keeps social login disabled with env placeholders, never literal secrets', () => {
    const google = customers.identityProviders?.find((i) => i.alias === 'google');
    expect(google?.enabled).toBe(false);
    expect(google?.config.clientSecret).toMatch(/^\$\{[A-Z_]+(:[^}]*)?\}$/);
  });

  it('keeps Jane', () => {
    expect(customers.users.map((u) => u.email)).toEqual(['jane@example.com']);
  });
});

describe('no secrets in any realm export', () => {
  it.each([staff, customers])(
    '$realm: no confidential client secrets, no literal idp secrets',
    (realm) => {
      for (const c of realm.clients) {
        expect(c.publicClient, `${c.clientId} must be public`).toBe(true);
        expect(c.secret, `${c.clientId} must not carry a secret`).toBeUndefined();
      }
      for (const idp of realm.identityProviders ?? []) {
        expect(idp.config.clientSecret).toMatch(/^\$\{/);
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------------
// Live checks against docker Keycloak.
const KC = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${KC}/realms/staff/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
const live = await reachable();

async function passwordGrant(realm: string, clientId: string, username: string, password: string) {
  const res = await fetch(`${KC}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, grant_type: 'password', username, password }),
  });
  const json = (await res.json()) as { access_token?: string; error?: string };
  return { status: res.status, ...json };
}
function claims(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
}

describe.runIf(live)('staff realm (live Keycloak)', () => {
  it('publishes OIDC discovery for both realms', async () => {
    for (const realm of ['staff', 'customers']) {
      const res = await fetch(`${KC}/realms/${realm}/.well-known/openid-configuration`);
      expect(res.status).toBe(200);
      const doc = (await res.json()) as { issuer: string; jwks_uri: string };
      expect(doc.issuer).toBe(`${KC}/realms/${realm}`);
      expect(doc.jwks_uri).toContain(`/realms/${realm}/protocol/openid-connect/certs`);
    }
  });

  it('test-cli password grant mints a token whose sub is the seeded keycloak_subject', async () => {
    const t = await passwordGrant('staff', 'test-cli', 'store-admin', 'store-admin');
    expect(t.status).toBe(200);
    const c = claims(t.access_token!);
    expect(c.sub).toBe('seed-store-admin');
    expect(c.email).toBe('store-admin@example.com');
    expect(c.preferred_username).toBe('store-admin');
    expect(c.aud).toBe('core-api');
    expect(c.iss).toBe(`${KC}/realms/staff`);
  });

  it('admin-app refuses the password grant', async () => {
    const t = await passwordGrant('staff', 'admin-app', 'store-admin', 'store-admin');
    expect(t.status).toBe(400);
    expect(t.access_token).toBeUndefined();
  });

  it('browser login as store-admin requires TOTP setup right after the password', async () => {
    const authUrl =
      `${KC}/realms/staff/protocol/openid-connect/auth?client_id=admin-app&response_type=code&scope=openid` +
      `&redirect_uri=${encodeURIComponent('http://localhost:3000/callback')}` +
      `&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=t`;
    const page = await fetch(authUrl, { redirect: 'manual' });
    const cookies = page.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const html = await page.text();
    const action = html
      .match(/id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]
      ?.replace(/&amp;/g, '&');
    expect(action, 'login form').toBeDefined();

    const after = await fetch(action!, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookies },
      body: new URLSearchParams({ username: 'store-admin', password: 'store-admin' }),
    });
    expect(after.status).toBe(302);
    const location = after.headers.get('location') ?? '';
    expect(location).toContain('login-actions/required-action');
    expect(location).toContain('execution=CONFIGURE_TOTP');
    expect(location).not.toContain('localhost:3000/callback');
  });

  it('customers realm: jane gets a token with email and store-less audience', async () => {
    const t = await passwordGrant('customers', 'test-cli', 'jane@example.com', 'jane');
    expect(t.status).toBe(200);
    const c = claims(t.access_token!);
    expect(c.sub).toBe('seed-jane');
    expect(c.email).toBe('jane@example.com');
    expect(c.aud).toBe('core-api');
  });
});
