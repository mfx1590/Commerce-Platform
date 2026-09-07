// Keycloak realm exports (infra/keycloak, issue #10).
// Static part: always runs, validates the JSON files against the seed contract and the security rules.
// Live part: runs only when the local Keycloak (KEYCLOAK_URL, default http://localhost:8180) answers.
import { createHmac } from 'node:crypto';
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
  credentials?: { type: string; value?: string; secretData?: string; credentialData?: string }[];
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

  it('dev browser flow: TOTP is CONDITIONAL — challenged only when enrolled (#43, manager decision)', () => {
    expect(staff.browserFlow).toBe('browser-mfa');
    expect(staff.otpPolicyType).toBe('totp');
    const top = staff.authenticationFlows?.find((f) => f.alias === 'browser-mfa');
    const forms = staff.authenticationFlows?.find((f) => f.alias === 'browser-mfa forms');
    const otpFlow = staff.authenticationFlows?.find((f) => f.alias === 'browser-mfa otp');
    expect(top?.topLevel).toBe(true);
    expect(top?.authenticationExecutions.map((e) => e.flowAlias ?? e.authenticator)).toEqual([
      'auth-cookie',
      'identity-provider-redirector',
      'browser-mfa forms',
    ]);
    expect(
      forms?.authenticationExecutions.map(
        (e) => `${e.flowAlias ?? e.authenticator}:${e.requirement}`,
      ),
    ).toEqual(['auth-username-password-form:REQUIRED', 'browser-mfa otp:CONDITIONAL']);
    expect(
      otpFlow?.authenticationExecutions.map((e) => `${e.authenticator}:${e.requirement}`),
    ).toEqual(['conditional-user-configured:REQUIRED', 'auth-otp-form:REQUIRED']);
  });

  it('owner (and only owner) is pre-enrolled with the documented dev TOTP secret', () => {
    const withOtp = staff.users
      .filter((u) => (u.credentials ?? []).some((c) => c.type === 'otp'))
      .map((u) => u.username);
    expect(withOtp).toEqual(['owner']);
    const cred = staff.users
      .find((u) => u.username === 'owner')!
      .credentials!.find((c) => c.type === 'otp')!;
    expect(JSON.parse(cred.secretData!)).toEqual({ value: OWNER_DEV_TOTP_SECRET });
    expect(JSON.parse(cred.credentialData!)).toMatchObject({
      subType: 'totp',
      digits: 6,
      period: 30,
      algorithm: 'HmacSHA1',
    });
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

/** Dev-only TOTP secret of the pre-enrolled `owner` user (infra/keycloak/README.md, issue #43). */
const OWNER_DEV_TOTP_SECRET = 'owner-dev-totp-secret-20260905';

/** RFC 6238 TOTP over the raw secret string (HmacSHA1, 6 digits, 30 s) — Keycloak's OTP policy. */
function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

/** Opens the admin-app authorization page and returns the login-form action plus a cookie-jar fetch. */
async function startBrowserLogin() {
  const jar = new Map<string, string>();
  const store = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv!.indexOf('=');
      jar.set(kv!.slice(0, i).trim(), kv!.slice(i + 1).trim());
    }
  };
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const authUrl =
    `${KC}/realms/staff/protocol/openid-connect/auth?client_id=admin-app&response_type=code&scope=openid` +
    `&redirect_uri=${encodeURIComponent('http://localhost:3000/callback')}` +
    `&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=t`;
  const page = await fetch(authUrl, { redirect: 'manual' });
  store(page);
  const html = await page.text();
  const action = html.match(/id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&');
  if (!action) throw new Error('login form not found');
  const postForm = async (url: string, fields: Record<string, string>) => {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader() },
      body: new URLSearchParams(fields),
    });
    store(res);
    return res;
  };
  /** 200 → its HTML; 302 to a Keycloak page → follow once with cookies. */
  const followToHtml = async (res: Response) => {
    if (res.status !== 302) return res.text();
    const next = await fetch(res.headers.get('location')!, {
      redirect: 'manual',
      headers: { cookie: cookieHeader() },
    });
    store(next);
    return next.text();
  };
  return { action, postForm, followToHtml };
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

  it('browser login as store-admin (no TOTP enrolled) reaches the app callback directly (#43)', async () => {
    const login = await startBrowserLogin();
    const after = await login.postForm(login.action, {
      username: 'store-admin',
      password: 'store-admin',
    });
    expect(after.status).toBe(302);
    const location = after.headers.get('location') ?? '';
    expect(location).toContain('http://localhost:3000/callback');
    expect(location).toContain('code=');
    expect(location).not.toContain('required-action');
  });

  it('browser login as owner (pre-enrolled) is challenged for TOTP and passes with the documented secret', async () => {
    const login = await startBrowserLogin();
    const after = await login.postForm(login.action, { username: 'owner', password: 'owner' });
    // CONDITIONAL flow: enrolled user gets the OTP form (200 page, never the app callback yet).
    expect(after.headers.get('location') ?? '').not.toContain('localhost:3000/callback');
    const otpHtml = await login.followToHtml(after);
    expect(otpHtml).toMatch(/name="otp"/);
    const otpAction = otpHtml
      .match(/<form[^>]*action="([^"]+)"[^>]*>(?:(?!<\/form>)[\s\S])*name="otp"/)?.[1]
      ?.replace(/&amp;/g, '&');
    expect(otpAction, 'otp form action').toBeDefined();

    let done = await login.postForm(otpAction!, { otp: totp(OWNER_DEV_TOTP_SECRET) });
    if (done.status !== 302) {
      // The current window's code was consumed elsewhere in this run (code reuse is off). The policy's
      // look-ahead of 1 also accepts the next window's (different) code; the error page re-renders the form.
      const retryHtml = await done.text();
      const retryAction = retryHtml
        .match(/<form[^>]*action="([^"]+)"[^>]*>(?:(?!<\/form>)[\s\S])*name="otp"/)?.[1]
        ?.replace(/&amp;/g, '&');
      expect(retryAction, 'otp retry form action').toBeDefined();
      done = await login.postForm(retryAction!, {
        otp: totp(OWNER_DEV_TOTP_SECRET, Date.now() + 30_000),
      });
    }
    expect(done.status).toBe(302);
    const location = done.headers.get('location') ?? '';
    expect(location).toContain('http://localhost:3000/callback');
    expect(location).toContain('code=');
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
