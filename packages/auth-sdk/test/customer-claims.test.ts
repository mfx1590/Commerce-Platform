// CustomerClaims.emailVerified (#307): true ONLY when the token's email_verified claim is the boolean true.
// Unit part: tokens signed by a throw-away key, served from a local JWKS endpoint — no Keycloak needed.
// Live part: runs only when the local Keycloak answers — the seeded jane (verified) and a freshly
// self-registered user (unverified: the dev realm has verifyEmail off).
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCustomerTokenVerifier, type CustomerTokenVerifier } from '../src/index.js';

describe('CustomerClaims.emailVerified (unit, local JWKS)', () => {
  const ISSUER_BASE = 'http://keycloak.test';
  const issuer = `${ISSUER_BASE}/realms/customers`;
  let server: Server;
  let verifier: CustomerTokenVerifier;
  let sign: (claims: Record<string, unknown>) => Promise<string>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'unit', alg: 'RS256', use: 'sig' };
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    verifier = createCustomerTokenVerifier({
      keycloakUrl: ISSUER_BASE,
      jwksUri: `http://127.0.0.1:${port}/certs`,
    });
    sign = (claims) =>
      new SignJWT({ store_code: 'brand-a', email: 'shopper@example.com', ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'unit' })
        .setIssuer(issuer)
        .setAudience('core-api')
        .setSubject('unit-shopper')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
  });

  afterAll(async () => {
    await new Promise((done) => server.close(done));
  });

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

// ---------------------------------------------------------------------------------------------------
// Live checks against docker Keycloak.
const KC = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const TOKEN_URL = `${KC}/realms/customers/protocol/openid-connect/token`;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

const live = await fetch(`${KC}/realms/customers/.well-known/openid-configuration`, {
  signal: AbortSignal.timeout(2000),
}).then(
  (r) => r.ok,
  () => false,
);

function rawClaims(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as Record<
    string,
    unknown
  >;
}

// RFC 7636 appendix B pair — the same challenge keycloak-realms.test.ts sends.
const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const CALLBACK = 'http://localhost:3101/auth/callback';

/** Self-registers through storefront-brand-a's registration form and returns the user's access token. */
async function registerAndSignIn(email: string, password: string): Promise<string> {
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
  const code = new URL(location).searchParams.get('code')!;

  const token = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'storefront-brand-a',
      code,
      redirect_uri: CALLBACK,
      code_verifier: PKCE_VERIFIER,
    }),
  });
  if (!token.ok) throw new Error(`code exchange: ${token.status} ${await token.text()}`);
  return ((await token.json()) as { access_token: string }).access_token;
}

/** Best effort: removes the registered user with the local bootstrap admin (as reimport.mjs does). */
async function deleteCustomer(subject: string): Promise<void> {
  const admin = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({
      client_id: 'admin-cli',
      grant_type: 'password',
      username: process.env.KEYCLOAK_ADMIN ?? 'admin',
      password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin',
    }),
  });
  if (!admin.ok) return;
  const { access_token } = (await admin.json()) as { access_token: string };
  await fetch(`${KC}/admin/realms/customers/users/${subject}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${access_token}` },
  });
}

describe.runIf(live)('CustomerClaims.emailVerified (live Keycloak)', () => {
  const registered: string[] = [];

  afterAll(async () => {
    for (const subject of registered) await deleteCustomer(subject).catch(() => undefined);
  });

  it('jane (seeded, emailVerified) → the token carries email_verified: true → emailVerified true', async () => {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: FORM,
      body: new URLSearchParams({
        client_id: 'test-cli',
        grant_type: 'password',
        username: 'jane@example.com',
        password: 'jane',
      }),
    });
    const { access_token } = (await res.json()) as { access_token: string };
    expect(rawClaims(access_token).email_verified).toBe(true);
    const claims = await createCustomerTokenVerifier().verify(access_token, 'brand-a');
    expect(claims).toMatchObject({ email: 'jane@example.com', emailVerified: true });
  });

  it('a freshly self-registered user → the token carries email_verified: false → emailVerified false', async () => {
    const email = `fresh-${randomUUID()}@example.com`;
    const token = await registerAndSignIn(email, `pw-${randomUUID()}`);
    const raw = rawClaims(token);
    registered.push(String(raw.sub));
    // The claim is emitted, as the boolean false — not omitted, not a string.
    expect(raw.email).toBe(email);
    expect(raw.email_verified).toBe(false);
    const claims = await createCustomerTokenVerifier().verify(token, 'brand-a');
    expect(claims).toMatchObject({ email, storeCode: 'brand-a', emailVerified: false });
  });
});
