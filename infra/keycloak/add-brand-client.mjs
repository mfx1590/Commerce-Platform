#!/usr/bin/env node
/**
 * Adds a brand's storefront client to the customers realm WITHOUT a reimport (wave 3, brand D).
 *
 *   node infra/keycloak/add-brand-client.mjs <brand-code> [--port N ...] [--host H ...]
 *        [--production-origin https://…] [--dry-run] [--json-only | --live-only] [--target-realm <name>] [--allow-remote]
 *
 * One template (brand-client.mjs, the same one brand-a/b/c in customers-realm.json are generated from):
 *
 *   1. the LIVE realm, through the admin API: POST the client if `storefront-<code>` does not exist, then add the
 *      template's default/optional client scopes to THAT client where Keycloak did not. Nothing else is ever
 *      written: no PUT or DELETE of an existing client, no realm update, no other client, user or session touched.
 *      An existing client is compared with the template and any drift is REPORTED (exit 3), never overwritten.
 *   2. the realm JSON (customers-realm.json) and the production profile (production/production-profile.json): the
 *      client and its profile entry are added if missing, so a future import keeps them. An existing entry that
 *      differs is reported, not rewritten. Both files are written as prettier formats them.
 *
 *   --port      the brand's dev port(s); default: apps/storefronts/<code>/package.json's `dev --port N`
 *   --host      extra https host(s), `<host>/auth/callback` (brand A's shop.dev/staging placeholders)
 *   --production-origin   the profile's origin; default https://shop-<letter>.example.com (the A/B/C placeholder
 *               pattern: the real domain is set in the profile when the brand is deployed)
 *   --dry-run   print every request and file change, send and write nothing (no admin token is fetched)
 *   --json-only the files only, no Keycloak
 *   --live-only the live realm only, no file written (CI's proof against its own throw-away Keycloak)
 *   --target-realm   apply to another live realm (a throw-away one when proving this script); default customers
 *
 * A reimport (reimport.mjs) DELETES the realm before importing it: every shopper and session in it. That stays an
 * owner-approved last resort; this script is the path for a new brand.
 *
 * Exit: 0 done (or nothing to do), 3 drift found (nothing changed for it), 1 error. Bootstrap admin from
 * KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD (dev defaults); a non-local KEYCLOAK_URL needs --allow-remote.
 * Prints client ids, URIs and scope names only: a storefront client is public, it has no secret.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URLSearchParams } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  brandClient,
  devPortFrom,
  drift,
  linkable,
  PROTOCOL_SCOPES,
  profileEntry,
  REALM,
} from './brand-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
export const REALM_FILE = resolve(here, 'customers-realm.json');
export const PROFILE_FILE = resolve(here, 'production/production-profile.json');

export function parseArgs(argv) {
  const a = {
    ports: [],
    hosts: [],
    dryRun: false,
    jsonOnly: false,
    liveOnly: false,
    allowRemote: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${v} needs a value`);
      return argv[++i];
    };
    if (v === '--port') a.ports.push(Number(next()));
    else if (v === '--host') a.hosts.push(next());
    else if (v === '--production-origin') a.productionOrigin = next();
    else if (v === '--target-realm') {
      a.targetRealm = next();
      if (!/^[a-z0-9-]+$/.test(a.targetRealm))
        throw new Error(`--target-realm must be [a-z0-9-]+, got "${a.targetRealm}"`);
    } else if (v === '--dry-run') a.dryRun = true;
    else if (v === '--json-only') a.jsonOnly = true;
    else if (v === '--live-only') a.liveOnly = true;
    else if (v === '--allow-remote') a.allowRemote = true;
    else if (v.startsWith('--')) throw new Error(`unknown flag ${v}`);
    else rest.push(v);
  }
  if (rest.length !== 1) throw new Error('exactly one brand code (e.g. brand-d)');
  if (a.jsonOnly && a.liveOnly) throw new Error('--json-only and --live-only exclude each other');
  a.code = rest[0];
  return a;
}

/** The ports: --port, else the brand app's own dev port. */
export function resolvePorts(code, ports, appsRoot = resolve(root, 'apps/storefronts')) {
  if (ports.length) return ports;
  const pkgFile = resolve(appsRoot, code, 'package.json');
  const port = existsSync(pkgFile)
    ? devPortFrom(JSON.parse(readFileSync(pkgFile, 'utf8')))
    : undefined;
  if (!port)
    throw new Error(`no --port, and ${pkgFile} has no \`dev --port N\` script: pass --port`);
  return [port];
}

export const defaultOrigin = (code) => `https://shop-${code.replace(/^brand-/, '')}.example.com`;

/** 2-space JSON through prettier: byte-identical to how both files are kept (checked when this was written). */
async function formatJson(obj, filepath) {
  const prettier = await import('prettier');
  return prettier.format(JSON.stringify(obj, null, 2), {
    ...(await prettier.resolveConfig(filepath)),
    filepath,
  });
}

/**
 * The realm JSON + the production profile. Pure on its inputs except the writes; returns what it did/would do.
 * The new client goes after the last storefront-* client, so the file keeps its grouping.
 */
export async function planFiles(want, origin, { realmText, profileText }) {
  const realm = JSON.parse(realmText);
  const profile = JSON.parse(profileText);
  const out = { realm: null, profile: null, drift: [], notes: [] };

  const have = realm.clients.find((c) => c.clientId === want.clientId);
  if (have) {
    out.drift.push(
      ...drift(want, have, {
        defaultScopes: have.defaultClientScopes,
        optionalScopes: have.optionalClientScopes,
      }).map((d) => `customers-realm.json: ${d}`),
    );
  } else {
    let at = -1;
    realm.clients.forEach((c, i) => {
      if (c.clientId.startsWith('storefront-')) at = i;
    });
    realm.clients.splice(at + 1, 0, want);
    out.realm = await formatJson(realm, REALM_FILE);
  }

  const clients = (profile.realms[REALM].clients ??= {});
  const entry = profileEntry(origin);
  if (clients[want.clientId]) {
    if (JSON.stringify(clients[want.clientId]) !== JSON.stringify(entry))
      // Expected once the brand is deployed (the profile holds its real domain): a note, not drift (#817 review).
      out.notes.push(
        `production-profile.json: ${want.clientId} is ${JSON.stringify(clients[want.clientId])} (kept; the placeholder would be ${JSON.stringify(entry)})`,
      );
  } else {
    clients[want.clientId] = entry;
    out.profile = await formatJson(profile, PROFILE_FILE);
  }
  return out;
}

// ---- the live realm ------------------------------------------------------------------------------------------

function keycloak({ url, admin, password, dryRun, log }) {
  let token;
  const api = async (method, path, body) => {
    if (dryRun && method !== 'GET') {
      log(`DRY RUN ${method} ${url}${path}${body ? `\n${JSON.stringify(body, null, 2)}` : ''}`);
      return undefined;
    }
    token ??= await (async () => {
      const r = await fetch(`${url}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username: admin,
          password,
        }),
      });
      if (!r.ok) throw new Error(`admin token: HTTP ${r.status}`);
      return (await r.json()).access_token;
    })();
    const r = await fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${await r.text()}`);
    const text = await r.text();
    return text ? JSON.parse(text) : undefined;
  };
  return api;
}

async function liveState(api, realm, clientId) {
  const [c] =
    (await api('GET', `/admin/realms/${realm}/clients?clientId=${encodeURIComponent(clientId)}`)) ??
    [];
  if (!c) return undefined;
  const names = async (kind) =>
    ((await api('GET', `/admin/realms/${realm}/clients/${c.id}/${kind}-client-scopes`)) ?? []).map(
      (s) => s.name,
    );
  return {
    client: c,
    defaultScopes: await names('default'),
    optionalScopes: await names('optional'),
  };
}

export async function applyLive(want, { realm, url, admin, password, dryRun, log }) {
  const api = keycloak({ url, admin, password, dryRun, log });
  if (dryRun) {
    // No token, no read: the dry run prints the request a create would send, and what follows it.
    log(
      `DRY RUN GET ${url}/admin/realms/${realm}/clients?clientId=${want.clientId} (exists? then compare only)`,
    );
    await api('POST', `/admin/realms/${realm}/clients`, want);
    log(
      `DRY RUN then: add any of [${want.defaultClientScopes}] / [${want.optionalClientScopes}] Keycloak did not link`,
    );
    return { created: false, drift: [] };
  }
  // Every client scope the template links must exist BEFORE anything is created: a missing one fails here, with the
  // realm untouched, not half-way after the POST (#817 review).
  const scopes = (await api('GET', `/admin/realms/${realm}/client-scopes`)) ?? [];
  const missing = [
    ...linkable(want.defaultClientScopes),
    ...linkable(want.optionalClientScopes),
  ].filter((n) => !scopes.some((s) => s.name === n));
  if (missing.length)
    throw new Error(
      `realm ${realm} has no client scope ${missing.map((n) => `"${n}"`).join(', ')}: nothing created`,
    );
  const before = await liveState(api, realm, want.clientId);
  if (before) {
    log(
      `${want.clientId} already exists in realm ${realm} (id ${before.client.id}): comparing, changing nothing`,
    );
    return { created: false, drift: drift(want, before.client, before) };
  }
  await api('POST', `/admin/realms/${realm}/clients`, want);
  log(`created ${want.clientId} in realm ${realm}`);
  // Keycloak links the representation's scopes on create; link any it did not, on THIS client only (additive).
  let now = await liveState(api, realm, want.clientId);
  log(
    `not linked (OIDC protocol scopes, not Keycloak client scopes): ${PROTOCOL_SCOPES.join(', ')}`,
  );
  for (const [kind, wanted, have] of [
    ['default', linkable(want.defaultClientScopes), now.defaultScopes],
    ['optional', linkable(want.optionalClientScopes), now.optionalScopes],
  ]) {
    for (const name of wanted.filter((n) => !have.includes(n))) {
      const s = scopes.find((x) => x.name === name);
      await api(
        'PUT',
        `/admin/realms/${realm}/clients/${now.client.id}/${kind}-client-scopes/${s.id}`,
      );
      log(`linked ${kind} scope ${name}`);
    }
  }
  now = await liveState(api, realm, want.clientId);
  return { created: true, drift: drift(want, now.client, now) };
}

// ---- CLI -----------------------------------------------------------------------------------------------------

async function main() {
  const log = (s) => console.info(s);
  let a;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(
      `${e.message}\nusage: node infra/keycloak/add-brand-client.mjs <brand-code> [--port N] [--host H] [--production-origin https://…] [--dry-run] [--json-only | --live-only] [--target-realm R] [--allow-remote]`,
    );
    process.exit(1);
  }
  const want = brandClient({ code: a.code, ports: resolvePorts(a.code, a.ports), hosts: a.hosts });
  const origin = a.productionOrigin ?? defaultOrigin(a.code);
  log(
    `${want.clientId}: redirects ${want.redirectUris.join(' ')}; store_code ${a.code}; production origin ${origin}`,
  );

  const allDrift = [];
  // The live realm FIRST: a failure there (Keycloak down, a 4xx) leaves the checkout clean (#817 review).
  if (!a.jsonOnly) {
    const url = (process.env.KEYCLOAK_URL ?? 'http://localhost:8180').replace(/\/+$/, '');
    const host = new URL(url).hostname;
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) && !a.allowRemote) {
      console.error(`refusing ${host}: a non-local Keycloak needs --allow-remote`);
      process.exit(1);
    }
    const live = await applyLive(want, {
      realm: a.targetRealm ?? REALM,
      url,
      admin: process.env.KEYCLOAK_ADMIN ?? 'admin',
      password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin',
      dryRun: a.dryRun,
      log,
    });
    allDrift.push(...live.drift.map((d) => `live realm: ${d}`));
  }

  if (!a.liveOnly) {
    const files = await planFiles(want, origin, {
      realmText: readFileSync(REALM_FILE, 'utf8'),
      profileText: readFileSync(PROFILE_FILE, 'utf8'),
    });
    let wrote = false;
    for (const [name, file, text] of [
      ['customers-realm.json', REALM_FILE, files.realm],
      ['production-profile.json', PROFILE_FILE, files.profile],
    ]) {
      if (text === null) log(`${name}: ${want.clientId} already there`);
      else if (a.dryRun) log(`DRY RUN would add ${want.clientId} to ${name}`);
      else {
        writeFileSync(file, text);
        wrote = true;
        log(`${name}: added ${want.clientId}`);
      }
    }
    for (const n of files.notes) log(`note: ${n}`);
    allDrift.push(...files.drift);
    if (a.dryRun && (files.realm !== null || files.profile !== null))
      log(
        'DRY RUN then: node infra/keycloak/derive-production.mjs customers (production/customers-realm.json)',
      );
    if (wrote) {
      // production/customers-realm.json is DERIVED from the two files above; production-realms.test.ts re-derives
      // and compares byte for byte, so it moves in the same change (#817 review).
      const r = spawnSync(process.execPath, [resolve(here, 'derive-production.mjs'), 'customers'], {
        encoding: 'utf8',
      });
      if (r.status !== 0) throw new Error(`derive-production.mjs customers failed:\n${r.stderr}`);
      log('production/customers-realm.json: re-derived (derive-production.mjs customers)');
      log(
        `next: packages/auth-sdk/test/production-realms.test.ts pins the production storefront clients (window 2's file): add ${want.clientId} there in the same PR`,
      );
    }
  }

  if (allDrift.length) {
    console.error(`DRIFT (nothing was changed for it):\n- ${allDrift.join('\n- ')}`);
    process.exit(3);
  }
  log('done: no drift');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
