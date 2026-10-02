// CustomerClaims.emailVerified (#307) and the verifier hardening that followed (#314).
// Unit part: tokens signed by a throw-away key, served from a local JWKS endpoint — no Keycloak needed.
// Live part: runs only when the local Keycloak answers — the seeded jane (verified), a freshly
// self-registered user (unverified: the dev realm has verifyEmail off) and an email change.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createCustomerTokenVerifier,
  createStaffTokenVerifier,
  type CustomerTokenVerifier,
} from '../src/index.js';

// ---------------------------------------------------------------- unit fixture: one key, one JWKS server
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
interface SignOptions {
  key?: SigningKey;
  issuer?: string;
  audience?: string;
  /** Seconds since the epoch; default: five minutes from now. */
  expiresAt?: number;
}

const ISSUER_BASE = 'http://keycloak.test';
const ISSUER = `${ISSUER_BASE}/realms/customers`;
const now = () => Math.floor(Date.now() / 1000);

let server: Server;
/** Origin of the local JWKS server; it answers every path with the key set and records the path. */
let jwksOrigin: string;
const requestedPaths: string[] = [];
let signingKey: SigningKey;
let verifier: CustomerTokenVerifier;

function sign(claims: Record<string, unknown>, opts: SignOptions = {}): Promise<string> {
  return new SignJWT({ store_code: 'brand-a', email: 'shopper@example.com', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'unit' })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? 'core-api')
    .setSubject('unit-shopper')
    .setIssuedAt(now() - 600)
    .setExpirationTime(opts.expiresAt ?? now() + 300)
    .sign(opts.key ?? signingKey);
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  signingKey = privateKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: 'unit', alg: 'RS256', use: 'sig' };
  server = createServer((req, res) => {
    requestedPaths.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  jwksOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  verifier = createCustomerTokenVerifier({
    keycloakUrl: ISSUER_BASE,
    jwksUri: `${jwksOrigin}/certs`,
  });
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
});

describe('CustomerClaims.emailVerified (unit, local JWKS)', () => {
  it('verified: email_verified === true → emailVerified true', async () => {
    const claims = await verifier.verify(await sign({ email_verified: true }), 'brand-a');
    expect(claims).toMatchObject({
      subject: 'unit-shopper',
      storeCode: 'brand-a',
      email: 'shopper@example.com',
      emailVerified: true,
    });
  });

  it('unverified: email_verified === false → emailVerified false', async () => {
    const claims = await verifier.verify(await sign({ email_verified: false }), 'brand-a');
    expect(claims.emailVerified).toBe(false);
    expect(claims.email).toBe('shopper@example.com');
  });

  it('claim absent → emailVerified false (the field is always present, never undefined)', async () => {
    const claims = await verifier.verify(await sign({}), 'brand-a');
    expect(claims).toHaveProperty('emailVerified', false);
  });

  it('claim as the string "true" → emailVerified false', async () => {
    const claims = await verifier.verify(await sign({ email_verified: 'true' }), 'brand-a');
    expect(claims.emailVerified).toBe(false);
  });

  it('claim null → emailVerified false', async () => {
    const claims = await verifier.verify(await sign({ email_verified: null }), 'brand-a');
    expect(claims.emailVerified).toBe(false);
  });

  it.each([[1], ['1'], ['yes'], [[true]], [{ value: true }]])(
    'other truthy value %j → emailVerified false',
    async (value) => {
      const claims = await verifier.verify(await sign({ email_verified: value }), 'brand-a');
      expect(claims.emailVerified).toBe(false);
    },
  );
});

// #314: a jwksUri override changes where the keys come from and nothing else — every other check holds.
describe('customer verifier rejects bad tokens with jwksUri set (unit, local JWKS)', () => {
  it('signed by a different key (same kid) → 401', async () => {
    const other = await generateKeyPair('RS256');
    const token = await sign({ email_verified: true }, { key: other.privateKey });
    await expect(verifier.verify(token, 'brand-a')).rejects.toMatchObject({
      status: 401,
      details: { reason: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' },
    });
  });

  it('expired → 401', async () => {
    const token = await sign({ email_verified: true }, { expiresAt: now() - 60 });
    await expect(verifier.verify(token, 'brand-a')).rejects.toMatchObject({
      status: 401,
      details: { reason: 'ERR_JWT_EXPIRED' },
    });
  });

  it('wrong issuer (another realm of the same Keycloak) → 401', async () => {
    const token = await sign({ email_verified: true }, { issuer: `${ISSUER_BASE}/realms/staff` });
    await expect(verifier.verify(token, 'brand-a')).rejects.toMatchObject({
      status: 401,
      details: { reason: 'ERR_JWT_CLAIM_VALIDATION_FAILED' },
    });
  });

  it('wrong audience → 401', async () => {
    const token = await sign({ email_verified: true }, { audience: 'account' });
    await expect(verifier.verify(token, 'brand-a')).rejects.toMatchObject({
      status: 401,
      details: { reason: 'ERR_JWT_CLAIM_VALIDATION_FAILED' },
    });
  });

  it('wrong store → 401 store_mismatch', async () => {
    const token = await sign({ email_verified: true });
    await expect(verifier.verify(token, 'brand-b')).rejects.toMatchObject({
      status: 401,
      details: { reason: 'store_mismatch' },
    });
  });
});

describe('jwksUri is a test-only override (#314)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('customer verifier: refuses jwksUri when NODE_ENV=production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() =>
      createCustomerTokenVerifier({ keycloakUrl: ISSUER_BASE, jwksUri: `${jwksOrigin}/certs` }),
    ).toThrow(/jwksUri/);
  });

  it('staff verifier: refuses jwksUri when NODE_ENV=production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() =>
      createStaffTokenVerifier({ keycloakUrl: ISSUER_BASE, jwksUri: `${jwksOrigin}/certs` }),
    ).toThrow(/jwksUri/);
  });

  it.each([
    ['customer', 'customers'],
    ['staff', 'staff'],
  ] as const)(
    '%s verifier, production, no override: the JWKS is fetched from the issuer itself',
    async (kind, realm) => {
      vi.stubEnv('NODE_ENV', 'production');
      const issuer = `${jwksOrigin}/realms/${realm}`;
      const token = await sign({ email_verified: true }, { issuer });
      requestedPaths.length = 0;
      if (kind === 'customer') {
        const claims = await createCustomerTokenVerifier({ keycloakUrl: jwksOrigin, realm }).verify(
          token,
          'brand-a',
        );
        expect(claims.issuer).toBe(issuer);
      } else {
        const claims = await createStaffTokenVerifier({ keycloakUrl: jwksOrigin, realm }).verify(
          token,
        );
        expect(claims.issuer).toBe(issuer);
      }
      expect(requestedPaths).toEqual([`/realms/${realm}/protocol/openid-connect/certs`]);
    },
  );
});

// ---------------------------------------------------------------------------------------------------
// Live checks against docker Keycloak.
const KC = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const TOKEN_URL = `${KC}/realms/customers/protocol/openid-connect/token`;
const ADMIN_URL = `${KC}/admin/realms/customers`;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

const live = await fetch(`${KC}/realms/customers/.well-known/openid-configuration`, {
  signal: AbortSignal.timeout(2000),
}).then(
  (r) => r.ok,
  () => false,
);

interface Tokens {
  access_token: string;
  refresh_token: string;
}
/** The account API's own profile representation (what the account console reads and posts back). */
interface AccountProfile {
  email?: string;
  userProfileMetadata?: { attributes: { name: string; readOnly: boolean }[] };
}

function rawClaims(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as Record<
    string,
    unknown
  >;
}

async function tokenRequest(fields: Record<string, string>): Promise<Tokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams(fields),
  });
  if (!res.ok) throw new Error(`token endpoint (${fields.grant_type}): ${res.status}`);
  return (await res.json()) as Tokens;
}

/** The storefront's own refresh: a new access token for the same session (refresh tokens rotate). */
const refresh = (tokens: Tokens) =>
  tokenRequest({
    grant_type: 'refresh_token',
    client_id: 'storefront-brand-a',
    refresh_token: tokens.refresh_token,
  });

// RFC 7636 appendix B pair — the same challenge keycloak-realms.test.ts sends.
const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const CALLBACK = 'http://localhost:3101/auth/callback';

/** Self-registers through storefront-brand-a's registration form and returns the user's tokens. */
async function registerAndSignIn(email: string, password: string): Promise<Tokens> {
  const jar = new Map<string, string>();
  const store = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv!.indexOf('=');
      jar.set(kv!.slice(0, i).trim(), kv!.slice(i + 1).trim());
    }
  };
  const cookie = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const unescape = (s: string) => s.replace(/&amp;/g, '&');

  const authorize =
    `${KC}/realms/customers/protocol/openid-connect/auth?client_id=storefront-brand-a` +
    `&response_type=code&scope=openid&redirect_uri=${encodeURIComponent(CALLBACK)}` +
    `&code_challenge=${PKCE_CHALLENGE}&code_challenge_method=S256&state=t`;
  const loginPage = await fetch(authorize, { redirect: 'manual' });
  store(loginPage);
  const registerHref = (await loginPage.text()).match(/href="([^"]*registration[^"]*)"/)?.[1];
  if (!registerHref) throw new Error('registration link not found on the login page');

  const formPage = await fetch(new URL(unescape(registerHref), KC), {
    redirect: 'manual',
    headers: { cookie: cookie() },
  });
  store(formPage);
  const action = (await formPage.text()).match(/id="kc-register-form"[^>]*action="([^"]+)"/)?.[1];
  if (!action) throw new Error('registration form not found');

  const submitted = await fetch(unescape(action), {
    method: 'POST',
    redirect: 'manual',
    headers: { ...FORM, cookie: cookie() },
    body: new URLSearchParams({
      email,
      firstName: 'Fresh',
      lastName: 'Shopper',
      password,
      'password-confirm': password,
    }),
  });
  const location = submitted.headers.get('location') ?? '';
  if (submitted.status !== 302 || !location.startsWith(`${CALLBACK}?`))
    throw new Error(`registration did not reach the callback: ${submitted.status} ${location}`);

  return tokenRequest({
    grant_type: 'authorization_code',
    client_id: 'storefront-brand-a',
    code: new URL(location).searchParams.get('code')!,
    redirect_uri: CALLBACK,
    code_verifier: PKCE_VERIFIER,
  });
}

/** Local bootstrap admin (infra/docker/docker-compose.yml), as infra/keycloak/reimport.mjs uses it. */
async function adminHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({
      client_id: 'admin-cli',
      grant_type: 'password',
      username: process.env.KEYCLOAK_ADMIN ?? 'admin',
      password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin',
    }),
  });
  if (!res.ok) throw new Error(`admin token: ${res.status}`);
  const { access_token } = (await res.json()) as { access_token: string };
  return { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' };
}

/** What the realm holds for the user — stands in for the verification mail the dev realm cannot send. */
async function markEmailVerified(subject: string): Promise<void> {
  const headers = await adminHeaders();
  const got = await fetch(`${ADMIN_URL}/users/${subject}`, { headers });
  if (!got.ok) throw new Error(`read user: ${got.status}`);
  const user = (await got.json()) as Record<string, unknown>;
  const put = await fetch(`${ADMIN_URL}/users/${subject}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ ...user, emailVerified: true }),
  });
  if (put.status !== 204) throw new Error(`mark verified: ${put.status}`);
}

/**
 * Deletes every user whose email starts with `tag` (a `fresh-<uuid>` prefix this file generated). Throws
 * when the admin API refuses: a test user left in the shared realm must fail the run, not hide.
 */
async function deleteCustomers(tag: string): Promise<void> {
  const headers = await adminHeaders();
  const found = await fetch(`${ADMIN_URL}/users?email=${encodeURIComponent(tag)}`, { headers });
  if (!found.ok) throw new Error(`find ${tag}: ${found.status}`);
  for (const user of (await found.json()) as { id: string; email?: string }[]) {
    if (!user.email?.startsWith(tag)) continue;
    const del = await fetch(`${ADMIN_URL}/users/${user.id}`, { method: 'DELETE', headers });
    if (del.status !== 204) throw new Error(`delete ${user.email}: ${del.status}`);
  }
}

describe.runIf(live)('CustomerClaims.emailVerified (live Keycloak)', () => {
  /** Email prefixes of the users this run may create — registered BEFORE the registration POST. */
  const tags: string[] = [];
  const freshTag = () => {
    const tag = `fresh-${randomUUID()}`;
    tags.push(tag);
    return tag;
  };

  afterAll(async () => {
    for (const tag of tags) await deleteCustomers(tag);
  });

  it('jane (seeded, emailVerified) → the token carries email_verified: true → emailVerified true', async () => {
    const { access_token } = await tokenRequest({
      client_id: 'test-cli',
      grant_type: 'password',
      username: 'jane@example.com',
      password: 'jane',
    });
    expect(rawClaims(access_token).email_verified).toBe(true);
    const claims = await createCustomerTokenVerifier().verify(access_token, 'brand-a');
    expect(claims).toMatchObject({ email: 'jane@example.com', emailVerified: true });
  });

  it('a freshly self-registered user → the token carries email_verified: false → emailVerified false', async () => {
    const email = `${freshTag()}@example.com`;
    const { access_token } = await registerAndSignIn(email, `pw-${randomUUID()}`);
    const raw = rawClaims(access_token);
    // The claim is emitted, as the boolean false — not omitted, not a string.
    expect(raw.email).toBe(email);
    expect(raw.email_verified).toBe(false);
    const claims = await createCustomerTokenVerifier().verify(access_token, 'brand-a');
    expect(claims).toMatchObject({ email, storeCode: 'brand-a', emailVerified: false });
  });

  // #314: #303 links guest orders by a verified email, so a verified user must not be able to move to
  // another address and keep the verification. The request below is the one the account console sends.
  it('a verified user cannot move to another address: the account API ignores the change, the token keeps the original', async () => {
    const tag = freshTag();
    const original = `${tag}@example.com`;
    const moved = `${tag}.moved@example.com`;
    let tokens = await registerAndSignIn(original, `pw-${randomUUID()}`);
    await markEmailVerified(String(rawClaims(tokens.access_token).sub));
    tokens = await refresh(tokens);
    expect(rawClaims(tokens.access_token)).toMatchObject({ email: original, email_verified: true });

    const account = `${KC}/realms/customers/account/`;
    const asUser = { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' };
    const profile = await fetch(account, { headers: asUser });
    expect(profile.status, 'account API: read own profile').toBe(200);
    const before = (await profile.json()) as AccountProfile;
    const changed = await fetch(account, {
      method: 'POST',
      headers: { ...asUser, 'content-type': 'application/json' },
      body: JSON.stringify({ ...before, email: moved }),
    });
    const after = (await (await fetch(account, { headers: asUser })).json()) as AccountProfile;

    const next = rawClaims((tokens = await refresh(tokens)).access_token);
    const carried = { email: next.email, email_verified: next.email_verified };
    // SECURITY FINDING if this fails — stop and report (#314): the token vouches for an unverified address.
    expect(carried).not.toEqual({ email: moved, email_verified: true });

    // Measured 2026-10-02 (Keycloak 26.0, this realm): the address does NOT move. Email is the username
    // and usernames are not editable, so the account API marks `email` read-only, answers 204 and ignores
    // the new value. The other safe outcome — address moved, email_verified reset to false — was not
    // observed and cannot be reached with this realm configuration. If one of the next four lines fails,
    // the realm now lets customers change their address: measure the reset before changing them.
    const emailAttribute = before.userProfileMetadata?.attributes.find((a) => a.name === 'email');
    expect(emailAttribute?.readOnly).toBe(true);
    expect(changed.status).toBe(204);
    expect(after.email).toBe(original);
    expect(carried).toEqual({ email: original, email_verified: true });

    const claims = await createCustomerTokenVerifier().verify(tokens.access_token, 'brand-a');
    expect(claims).toMatchObject({ email: original, emailVerified: true });
  });
});
