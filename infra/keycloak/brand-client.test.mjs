// node --test infra/keycloak/brand-client.test.mjs   (CI: the live auth job, which has pnpm install for prettier)
/* global structuredClone, Response */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyLive,
  defaultOrigin,
  parseArgs,
  planFiles,
  PROFILE_FILE,
  REALM_FILE,
  resolvePorts,
} from './add-brand-client.mjs';
import { brandClient, devPortFrom, drift } from './brand-client.mjs';

const realmText = readFileSync(REALM_FILE, 'utf8');
const profileText = readFileSync(PROFILE_FILE, 'utf8');
const realm = JSON.parse(realmText);
const fileClient = (id) => realm.clients.find((c) => c.clientId === id);
const SCRIPT = fileURLToPath(new URL('./add-brand-client.mjs', import.meta.url));

// brand A also serves the starter's port and keeps the shop.dev/staging placeholder hosts; B and C are one port each
const PARAMS = {
  'brand-a': { ports: [3100, 3101], hosts: ['shop.dev.example.com', 'shop.staging.example.com'] },
  'brand-b': { ports: [3102] },
  'brand-c': { ports: [3103] },
};

test('ONE template: brand-a/b/c in customers-realm.json are exactly its output (key order included)', () => {
  for (const [code, p] of Object.entries(PARAMS)) {
    const want = brandClient({ code, ...p });
    assert.equal(
      JSON.stringify(want),
      JSON.stringify(fileClient(`storefront-${code}`)),
      `storefront-${code} drifted from the template`,
    );
  }
  // and the realm has no other storefront client the template does not account for
  const storefronts = realm.clients
    .map((c) => c.clientId)
    .filter((id) => id.startsWith('storefront-'));
  assert.deepEqual(
    storefronts,
    Object.keys(PARAMS).map((c) => `storefront-${c}`),
  );
});

test('the security shape of every brand client: public, code + PKCE S256 only, its own store_code, the core-api audience', () => {
  const c = brandClient({ code: 'brand-d', ports: [3104] });
  assert.equal(c.publicClient, true);
  assert.equal(c.standardFlowEnabled, true);
  assert.equal(c.implicitFlowEnabled, false);
  assert.equal(c.directAccessGrantsEnabled, false, 'no password grant on a storefront');
  assert.equal(c.serviceAccountsEnabled, false);
  assert.equal(c.attributes['pkce.code.challenge.method'], 'S256');
  assert.deepEqual(c.redirectUris, ['http://localhost:3104/*']);
  assert.deepEqual(c.webOrigins, ['http://localhost:3104']);
  const store = c.protocolMappers.find((m) => m.name === 'store code');
  assert.equal(store.config['claim.value'], 'brand-d');
  assert.equal(
    c.protocolMappers.find((m) => m.protocolMapper === 'oidc-audience-mapper').config[
      'included.custom.audience'
    ],
    'core-api',
  );
  assert.ok(!('secret' in c), 'a public client carries no secret');
});

test('inputs are refused, not guessed', () => {
  assert.throws(() => brandClient({ code: 'Brand D', ports: [3104] }), /lower-case kebab/);
  assert.throws(() => brandClient({ code: 'brand-d', ports: [] }), /ports/);
  assert.throws(() => brandClient({ code: 'brand-d', ports: [99999] }), /ports/);
  assert.throws(
    () => brandClient({ code: 'brand-d', ports: [3104], hosts: ['https://x.example.com/'] }),
    /bare DNS/,
  );
  assert.throws(() => parseArgs([]), /exactly one brand code/);
  assert.throws(() => parseArgs(['brand-d', '--json-only', '--live-only']), /exclude each other/);
  assert.throws(() => parseArgs(['brand-d', '--port']), /needs a value/);
  assert.throws(() => parseArgs(['brand-d', '--force']), /unknown flag/);
  assert.equal(defaultOrigin('brand-d'), 'https://shop-d.example.com');
});

test("the dev port comes from the brand app's own dev script, and matches the realm file", () => {
  for (const [code, port] of [
    ['brand-a', 3101],
    ['brand-b', 3102],
    ['brand-c', 3103],
  ]) {
    const pkg = JSON.parse(
      readFileSync(new URL(`../../apps/storefronts/${code}/package.json`, import.meta.url), 'utf8'),
    );
    assert.equal(devPortFrom(pkg), port, code);
    assert.deepEqual(resolvePorts(code, []), [port]);
  }
  assert.deepEqual(resolvePorts('brand-d', [3104]), [3104], '--port wins');
  assert.throws(() => resolvePorts('brand-nope', []), /pass --port/);
});

test('drift: the same client is none; a changed redirect, a missing or extra mapper, a scope are each named', () => {
  const want = brandClient({ code: 'brand-b', ports: [3102] });
  const live = structuredClone(want);
  // what Keycloak adds of its own is not drift
  Object.assign(live, { id: 'x', surrogateAuthRequired: false });
  live.attributes['backchannel.logout.session.required'] = 'true';
  const scopes = {
    defaultScopes: want.defaultClientScopes,
    optionalScopes: want.optionalClientScopes,
  };
  assert.deepEqual(drift(want, live, scopes), []);

  const changed = structuredClone(live);
  changed.redirectUris = ['http://localhost:3999/*'];
  changed.protocolMappers = changed.protocolMappers.filter((m) => m.name !== 'store code');
  changed.protocolMappers.push({
    name: 'extra',
    protocolMapper: 'oidc-hardcoded-claim-mapper',
    config: {},
  });
  const d = drift(want, changed, { defaultScopes: ['openid'], optionalScopes: [] });
  assert.ok(d.some((l) => l.startsWith('redirectUris:')));
  assert.ok(d.includes('protocolMappers: "store code" missing'));
  assert.ok(d.includes('protocolMappers: extra "extra" (not in the template)'));
  assert.ok(d.some((l) => l.startsWith('defaultClientScopes:')));
  assert.ok(d.some((l) => l.startsWith('optionalClientScopes:')));
});

test('the files: brand D is ADDED after the last storefront client, nothing else changes, and a re-run does nothing', async () => {
  const want = brandClient({ code: 'brand-d', ports: [3104] });
  const r = await planFiles(want, defaultOrigin('brand-d'), { realmText, profileText });
  assert.deepEqual(r.drift, []);
  const after = JSON.parse(r.realm);
  const ids = after.clients.map((c) => c.clientId);
  assert.equal(ids.indexOf('storefront-brand-d'), ids.indexOf('storefront-brand-c') + 1);
  assert.deepEqual(
    after.clients.filter((c) => c.clientId !== 'storefront-brand-d'),
    realm.clients,
    'every other client is untouched',
  );
  assert.deepEqual(
    { ...after, clients: undefined },
    { ...realm, clients: undefined },
    'nothing outside clients changes',
  );
  // additive at the text level too: every original line is still there, in order
  const before = realmText.split('\n');
  const lines = r.realm.split('\n');
  let j = 0;
  for (const l of lines) if (l === before[j]) j++;
  assert.equal(j, before.length, 'the realm file only gained lines');

  const profile = JSON.parse(r.profile);
  assert.deepEqual(profile.realms.customers.clients['storefront-brand-d'], {
    origin: 'https://shop-d.example.com',
    callback: 'https://shop-d.example.com/auth/callback',
  });
  assert.deepEqual(
    { ...profile.realms.customers.clients, 'storefront-brand-d': undefined },
    { ...JSON.parse(profileText).realms.customers.clients, 'storefront-brand-d': undefined },
  );

  // idempotent: run on its own output, nothing to write, nothing drifted
  const again = await planFiles(want, defaultOrigin('brand-d'), {
    realmText: r.realm,
    profileText: r.profile,
  });
  assert.deepEqual(again, { realm: null, profile: null, drift: [] });
  // an existing brand: nothing written; a different port is reported, never rewritten
  const b = await planFiles(
    brandClient({ code: 'brand-b', ports: [3102] }),
    'https://shop-b.example.com',
    { realmText, profileText },
  );
  assert.deepEqual(b, { realm: null, profile: null, drift: [] });
  const moved = await planFiles(
    brandClient({ code: 'brand-b', ports: [3112] }),
    'https://shop-b.example.com',
    { realmText, profileText },
  );
  assert.equal(moved.realm, null);
  assert.ok(moved.drift.some((l) => l.startsWith('customers-realm.json: redirectUris:')));
});

/** A fake Keycloak admin API: records every request; the realm starts with the given clients. */
function fakeKeycloak(existing = []) {
  const calls = [];
  const clients = existing.map((c, i) => ({ ...structuredClone(c), id: `id-${i}` }));
  const scopes = [
    'openid',
    'profile',
    'email',
    'roles',
    'web-origins',
    'basic',
    'offline_access',
    'acr',
  ].map((name) => ({
    id: `s-${name}`,
    name,
  }));
  const links = new Map(
    clients.map((c) => [
      c.id,
      { default: [...c.defaultClientScopes], optional: [...c.optionalClientScopes] },
    ]),
  );
  const json = (b) => new Response(JSON.stringify(b), { status: 200 });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${u.pathname}${u.search}`);
    if (u.pathname.endsWith('/openid-connect/token')) return json({ access_token: 't' });
    let m;
    if (method === 'GET' && u.pathname === '/admin/realms/customers/clients')
      return json(clients.filter((c) => c.clientId === u.searchParams.get('clientId')));
    if (method === 'POST' && u.pathname === '/admin/realms/customers/clients') {
      const rep = JSON.parse(init.body);
      const c = { ...rep, id: `id-${clients.length}` };
      clients.push(c);
      // like Keycloak: link the representation's default scopes, but (say) not the optional ones
      links.set(c.id, { default: [...rep.defaultClientScopes], optional: [] });
      return new Response('', { status: 201 });
    }
    if (
      method === 'GET' &&
      (m = /\/clients\/([^/]+)\/(default|optional)-client-scopes$/.exec(u.pathname))
    )
      return json(links.get(m[1])[m[2]].map((name) => scopes.find((s) => s.name === name)));
    if (method === 'GET' && u.pathname === '/admin/realms/customers/client-scopes')
      return json(scopes);
    if (
      method === 'PUT' &&
      (m = /\/clients\/([^/]+)\/(default|optional)-client-scopes\/([^/]+)$/.exec(u.pathname))
    ) {
      links.get(m[1])[m[2]].push(scopes.find((s) => s.id === m[3]).name);
      return new Response(null, { status: 204 });
    }
    return new Response('unexpected', { status: 500 });
  };
  return { fetch, calls, clients };
}

async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const opts = {
  realm: 'customers',
  url: 'http://localhost:8180',
  admin: 'admin',
  password: 'admin',
  dryRun: false,
  log: () => {},
};

test('live: a new brand is POSTed, the missing scope linked on IT, and nothing else is written', async () => {
  const kc = fakeKeycloak([fileClient('storefront-brand-a'), fileClient('storefront-brand-b')]);
  const want = brandClient({ code: 'brand-d', ports: [3104] });
  const r = await withFetch(kc, () => applyLive(want, opts));
  assert.deepEqual(r, { created: true, drift: [] });
  const writes = kc.calls.filter((c) => !c.startsWith('GET') && !c.includes('/token'));
  assert.deepEqual(writes, [
    'POST /admin/realms/customers/clients',
    'PUT /admin/realms/customers/clients/id-2/optional-client-scopes/s-offline_access',
  ]);
  assert.ok(!kc.calls.some((c) => c.startsWith('DELETE')));
});

test('live: an existing client is only read; drift is reported, never written', async () => {
  const b = fileClient('storefront-brand-b');
  const kc = fakeKeycloak([b]);
  const same = await withFetch(kc, () =>
    applyLive(brandClient({ code: 'brand-b', ports: [3102] }), opts),
  );
  assert.deepEqual(same, { created: false, drift: [] });
  const moved = await withFetch(kc, () =>
    applyLive(brandClient({ code: 'brand-b', ports: [3112] }), opts),
  );
  assert.equal(moved.created, false);
  assert.ok(moved.drift.some((l) => l.startsWith('redirectUris:')));
  assert.ok(
    kc.calls.every((c) => c.startsWith('GET') || c.includes('/token')),
    kc.calls.join('\n'),
  );
});

test('--dry-run prints the request, sends nothing (no token), writes no file', () => {
  const before = [statSync(REALM_FILE).mtimeMs, statSync(PROFILE_FILE).mtimeMs];
  const r = spawnSync(process.execPath, [SCRIPT, 'brand-d', '--port', '3104', '--dry-run'], {
    encoding: 'utf8',
    // a port nothing listens on: any request would fail the run
    env: { ...process.env, KEYCLOAK_URL: 'http://127.0.0.1:9' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /DRY RUN POST http:\/\/127\.0\.0\.1:9\/admin\/realms\/customers\/clients\n\{\n {2}"clientId": "storefront-brand-d"/,
  );
  assert.match(r.stdout, /"claim\.value": "brand-d"/);
  assert.match(r.stdout, /DRY RUN would add storefront-brand-d to customers-realm\.json/);
  assert.match(r.stdout, /DRY RUN would add storefront-brand-d to production-profile\.json/);
  assert.deepEqual([statSync(REALM_FILE).mtimeMs, statSync(PROFILE_FILE).mtimeMs], before);
});

test('a non-local Keycloak is refused without --allow-remote', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'brand-d', '--port', '3104', '--live-only'], {
    encoding: 'utf8',
    env: { ...process.env, KEYCLOAK_URL: 'https://auth.example.com' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing auth\.example\.com/);
});
