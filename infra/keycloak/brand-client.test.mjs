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

/** A client's template inputs, read back from the client itself: localhost ports from its redirects, https hosts. */
const paramsOf = (c) => ({
  code: c.clientId.replace(/^storefront-/, ''),
  ports: c.redirectUris
    .map((u) => /^http:\/\/localhost:(\d+)\/\*$/.exec(u)?.[1])
    .filter(Boolean)
    .map(Number),
  hosts: c.webOrigins
    .filter((o) => o.startsWith('https://'))
    .map((o) => o.slice('https://'.length)),
});

test('ONE template: EVERY storefront-* client in customers-realm.json is exactly its output (key order included)', () => {
  const storefronts = realm.clients.filter((c) => c.clientId.startsWith('storefront-'));
  // generic, so a brand the script adds (brand D) is covered with no edit here (#817 review)
  for (const c of storefronts)
    assert.equal(
      JSON.stringify(brandClient(paramsOf(c))),
      JSON.stringify(c),
      `${c.clientId} drifted from the template`,
    );
  // today's three, read back to the inputs they were written from
  assert.deepEqual(paramsOf(fileClient('storefront-brand-a')), {
    code: 'brand-a',
    ports: [3100, 3101],
    hosts: ['shop.dev.example.com', 'shop.staging.example.com'],
  });
  assert.ok(storefronts.length >= 3);
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
  assert.throws(
    () => parseArgs(['brand-d', '--target-realm', '../master']),
    /--target-realm must be/,
  );
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
  const want = brandClient({ code: 'brand-zz', ports: [3199] });
  const r = await planFiles(want, defaultOrigin('brand-zz'), { realmText, profileText });
  assert.deepEqual(r.drift, []);
  const after = JSON.parse(r.realm);
  const ids = after.clients.map((c) => c.clientId);
  assert.equal(
    ids.indexOf('storefront-brand-zz'),
    ids.findLastIndex(
      (id, i) => i < ids.indexOf('storefront-brand-zz') && id.startsWith('storefront-'),
    ) + 1,
    'right after the last storefront client',
  );
  assert.ok(
    ids.slice(ids.indexOf('storefront-brand-zz') + 1).every((id) => !id.startsWith('storefront-')),
    'and no storefront client after it',
  );
  assert.deepEqual(
    after.clients.filter((c) => c.clientId !== 'storefront-brand-zz'),
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
  assert.deepEqual(profile.realms.customers.clients['storefront-brand-zz'], {
    origin: 'https://shop-zz.example.com',
    callback: 'https://shop-zz.example.com/auth/callback',
  });
  assert.deepEqual(
    { ...profile.realms.customers.clients, 'storefront-brand-zz': undefined },
    { ...JSON.parse(profileText).realms.customers.clients, 'storefront-brand-zz': undefined },
  );

  // idempotent: run on its own output, nothing to write, nothing drifted
  const again = await planFiles(want, defaultOrigin('brand-zz'), {
    realmText: r.realm,
    profileText: r.profile,
  });
  assert.deepEqual(again, { realm: null, profile: null, drift: [], notes: [] });
  // and the added client passes the template test's own read-back
  const d = JSON.parse(r.realm).clients.find((c) => c.clientId === 'storefront-brand-zz');
  assert.equal(JSON.stringify(brandClient(paramsOf(d))), JSON.stringify(d));
  // an existing brand: nothing written; a different port is reported, never rewritten
  const b = await planFiles(
    brandClient({ code: 'brand-b', ports: [3102] }),
    'https://shop-b.example.com',
    { realmText, profileText },
  );
  assert.deepEqual(b, { realm: null, profile: null, drift: [], notes: [] });
  // a deployed brand's real domain in the profile is a NOTE, never drift (exit 3) (#817 review)
  const a = await planFiles(
    brandClient({
      code: 'brand-a',
      ports: [3100, 3101],
      hosts: ['shop.dev.example.com', 'shop.staging.example.com'],
    }),
    defaultOrigin('brand-a'),
    { realmText, profileText },
  );
  assert.deepEqual(a.drift, []);
  assert.match(
    a.notes[0],
    /storefront-brand-a is .*shop\.example\.com.* \(kept; the placeholder would be/,
  );
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
  // like Keycloak 26: there is NO client scope `openid` (an OIDC protocol scope value)
  const scopes = ['profile', 'email', 'roles', 'web-origins', 'basic', 'offline_access', 'acr'].map(
    (name) => ({
      id: `s-${name}`,
      name,
    }),
  );
  const links = new Map(
    clients.map((c) => [
      c.id,
      {
        default: c.defaultClientScopes.filter((n) => scopes.some((s) => s.name === n)),
        optional: c.optionalClientScopes.filter((n) => scopes.some((s) => s.name === n)),
      },
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
      // like Keycloak: link the representation's default scopes THAT EXIST (`openid` is ignored), and (say) not the
      // optional ones, so the script's own link step is exercised
      links.set(c.id, {
        default: rep.defaultClientScopes.filter((n) => scopes.some((s) => s.name === n)),
        optional: [],
      });
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

test('live: openid is never linked nor drift; a scope the realm lacks fails BEFORE the POST', async () => {
  const kc = fakeKeycloak([]);
  const logs = [];
  const r = await withFetch(kc, () =>
    applyLive(brandClient({ code: 'brand-d', ports: [3104] }), {
      ...opts,
      log: (l) => logs.push(l),
    }),
  );
  assert.deepEqual(r, { created: true, drift: [] });
  assert.ok(
    !kc.calls.some((c) => c.includes('/s-openid')),
    'openid is not a client scope: never PUT',
  );
  assert.ok(logs.some((l) => /not linked \(OIDC protocol scopes/.test(l)));

  const want = brandClient({ code: 'brand-e', ports: [3105] });
  want.optionalClientScopes = ['offline_access', 'no-such-scope'];
  const kc2 = fakeKeycloak([]);
  await assert.rejects(
    withFetch(kc2, () => applyLive(want, opts)),
    /realm customers has no client scope "no-such-scope": nothing created/,
  );
  assert.ok(!kc2.calls.some((c) => c.startsWith('POST /admin')), 'nothing was created');
  assert.equal(
    drift(want, want, {
      defaultScopes: ['profile', 'email', 'roles', 'web-origins', 'basic'],
      optionalScopes: want.optionalClientScopes,
    }).length,
    0,
  );
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
  const r = spawnSync(process.execPath, [SCRIPT, 'brand-zz', '--port', '3199', '--dry-run'], {
    encoding: 'utf8',
    // a port nothing listens on: any request would fail the run
    env: { ...process.env, KEYCLOAK_URL: 'http://127.0.0.1:9' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /DRY RUN POST http:\/\/127\.0\.0\.1:9\/admin\/realms\/customers\/clients\n\{\n {2}"clientId": "storefront-brand-zz"/,
  );
  assert.match(r.stdout, /"claim\.value": "brand-zz"/);
  assert.match(r.stdout, /DRY RUN would add storefront-brand-zz to customers-realm\.json/);
  assert.match(r.stdout, /DRY RUN would add storefront-brand-zz to production-profile\.json/);
  assert.match(r.stdout, /DRY RUN then: node infra\/keycloak\/derive-production\.mjs customers/);
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
