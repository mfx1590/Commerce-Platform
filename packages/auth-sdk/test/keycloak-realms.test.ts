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
  rootUrl?: string;
  redirectUris?: string[];
  webOrigins?: string[];
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

  // #212: the starter (:3100) and brand A (:3101) both sign in through storefront-brand-a; brand B/C
  // serve on :3102/:3103. The shop.<env> hosts are the storefront ingress hosts of infra/helm.
  const registered = {
    'storefront-brand-a': {
      redirectUris: [
        'http://localhost:3100/*',
        'http://localhost:3101/*',
        'https://shop.dev.example.com/auth/callback',
        'https://shop.staging.example.com/auth/callback',
      ],
      webOrigins: [
        'http://localhost:3100',
        'http://localhost:3101',
        'https://shop.dev.example.com',
        'https://shop.staging.example.com',
      ],
      postLogout: [
        'http://localhost:3100/*',
        'http://localhost:3101/*',
        'https://shop.dev.example.com/',
        'https://shop.staging.example.com/',
      ],
    },
    'storefront-brand-b': {
      redirectUris: ['http://localhost:3102/*'],
      webOrigins: ['http://localhost:3102'],
      postLogout: ['http://localhost:3102/*'],
    },
    'storefront-brand-c': {
      redirectUris: ['http://localhost:3103/*'],
      webOrigins: ['http://localhost:3103'],
      postLogout: ['http://localhost:3103/*'],
    },
  };
  const postLogoutUris = (c: Client) =>
    (c.attributes?.['post.logout.redirect.uris'] ?? '').split('##').filter(Boolean);

  it.each(Object.entries(registered))(
    '%s registers exactly its own redirect URIs, web origins and post-logout URIs (#212)',
    (id, expected) => {
      const c = client(customers, id);
      expect(c.redirectUris).toEqual(expected.redirectUris);
      expect(c.webOrigins).toEqual(expected.webOrigins);
      expect(postLogoutUris(c)).toEqual(expected.postLogout);
    },
  );

  it('redirect URIs: no wildcard hosts, https and no wildcard at all off localhost, one client per origin', () => {
    const LOCAL = /^http:\/\/localhost:\d+\/\*$/;
    const ownerOf = new Map<string, string>();
    for (const c of customers.clients) {
      const redirects = c.redirectUris ?? [];
      for (const uri of [...redirects, ...postLogoutUris(c)]) {
        if (LOCAL.test(uri)) continue;
        expect(uri, `${c.clientId}: ${uri}`).not.toContain('*');
        const url = new URL(uri);
        expect(url.protocol, `${c.clientId}: ${uri}`).toBe('https:');
        expect(url.search + url.hash, `${c.clientId}: ${uri}`).toBe('');
      }
      // Web origins are spelled out: never `*`, never `+` (which would follow the redirect URIs).
      expect(c.webOrigins ?? []).toEqual(redirects.map((uri) => new URL(uri).origin));
      // A second client on the same origin could mint another brand's store_code for it (ADR 0002 §8).
      for (const origin of c.webOrigins ?? []) {
        expect(ownerOf.get(origin), `${origin} is registered on two clients`).toBeUndefined();
        ownerOf.set(origin, c.clientId);
      }
    }
  });

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

const authorizeUrl = (realm: string, clientId: string, redirectUri: string) =>
  `${KC}/realms/${realm}/protocol/openid-connect/auth?client_id=${clientId}&response_type=code&scope=openid` +
  `&redirect_uri=${encodeURIComponent(redirectUri)}` +
  `&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=t`;

/** Opens a client's authorization page (admin-app by default) and returns the login-form action plus a cookie-jar fetch. */
async function startBrowserLogin(
  realm = 'staff',
  clientId = 'admin-app',
  redirectUri = 'http://localhost:3000/callback',
) {
  const jar = new Map<string, string>();
  const store = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv!.indexOf('=');
      jar.set(kv!.slice(0, i).trim(), kv!.slice(i + 1).trim());
    }
  };
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const page = await fetch(authorizeUrl(realm, clientId, redirectUri), { redirect: 'manual' });
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

  it('customers realm: jane signs in from brand A on :3101 and lands on its callback (#212)', async () => {
    const callback = 'http://localhost:3101/auth/callback';
    const login = await startBrowserLogin('customers', 'storefront-brand-a', callback);
    const after = await login.postForm(login.action, {
      username: 'jane@example.com',
      password: 'jane',
    });
    expect(after.status).toBe(302);
    const location = after.headers.get('location') ?? '';
    expect(location.startsWith(`${callback}?`)).toBe(true);
    expect(location).toContain('code=');
  });

  it.each([
    ['storefront-brand-a', 'https://shop.dev.example.com/auth/callback', 200],
    ['storefront-brand-a', 'https://shop.staging.example.com/auth/callback', 200],
    // Exact URIs: another path on the same host, plain http, or another brand's port are refused.
    ['storefront-brand-a', 'https://shop.dev.example.com/auth/callback/extra', 400],
    ['storefront-brand-a', 'http://shop.dev.example.com/auth/callback', 400],
    ['storefront-brand-a', 'http://localhost:3102/auth/callback', 400],
    ['storefront-brand-b', 'http://localhost:3101/auth/callback', 400],
    ['storefront-brand-b', 'http://localhost:3102/auth/callback', 200],
    ['storefront-brand-c', 'http://localhost:3103/auth/callback', 200],
  ])(
    'customers realm: %s authorization with redirect_uri %s → %i (#212)',
    async (id, uri, status) => {
      const res = await fetch(authorizeUrl('customers', id, uri), { redirect: 'manual' });
      expect(res.status).toBe(status);
    },
  );
});
