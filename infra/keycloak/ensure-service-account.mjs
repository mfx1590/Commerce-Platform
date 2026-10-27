#!/usr/bin/env node
// Additive alternative to a realm reimport (#483, generalised for #565 / #622):
//   node infra/keycloak/ensure-service-account.mjs <staff|customers> [clientId ...] [--target-realm <name>] [--allow-remote]
// Creates, in the LIVE realm through the admin API, exactly what the realm export declares for each named
// service-account client (default: every client of the export with `serviceAccountsEnabled`): the confidential
// client, its service-account user — with the export's fixed `id` when it declares one, because a seeded
// staff_user row is keyed on it (the token's `sub`) — and the user's realm-management role mappings, if any.
// Idempotent: an existing client is left as it is; a service-account user whose id differs from the export's
// is replaced by one with the export's id (that user only — partialImport OVERWRITE of a single user); missing
// role mappings are added, extra ones reported, never removed. No realm delete, no reimport: every other
// client, user and session stays untouched. Bootstrap admin from the environment (KEYCLOAK_ADMIN /
// KEYCLOAK_ADMIN_PASSWORD, dev defaults). Prints ids and role names only — never a secret.
//
// The export's clients carry their DEV secrets, so a non-local KEYCLOAK_URL is refused unless --allow-remote
// is given (#514 review). --target-realm applies the export's declarations to another live realm (a
// throw-away realm when measuring this script); default: the realm of the export.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URLSearchParams } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const KC = (process.env.KEYCLOAK_URL ?? 'http://localhost:8180').replace(/\/+$/, '');
const ADMIN_USER = process.env.KEYCLOAK_ADMIN ?? 'admin';
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const allowRemote = argv.includes('--allow-remote');
if (allowRemote) argv.splice(argv.indexOf('--allow-remote'), 1);
const targetRealmArg = flag('--target-realm');
const [realm, ...clientIds] = argv;
if (!['staff', 'customers'].includes(realm)) {
  console.error(
    'usage: node infra/keycloak/ensure-service-account.mjs <staff|customers> [clientId ...] [--target-realm <name>] [--allow-remote]',
  );
  process.exit(1);
}
const host = new URL(KC).hostname;
if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) && !allowRemote) {
  console.error(
    `refusing ${host}: the export carries dev-only secrets; pass --allow-remote only for a dev/test Keycloak`,
  );
  process.exit(1);
}
const targetRealm = targetRealmArg ?? realm;

const exportFile = JSON.parse(readFileSync(resolve(here, `${realm}-realm.json`), 'utf8'));
const declared = exportFile.clients.filter((c) => c.serviceAccountsEnabled);
const wantedIds = clientIds.length > 0 ? clientIds : declared.map((c) => c.clientId);
for (const id of wantedIds) {
  if (!declared.some((c) => c.clientId === id)) {
    console.error(`${realm}-realm.json declares no service-account client "${id}"`);
    process.exit(1);
  }
}

const tok = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: 'admin-cli',
    grant_type: 'password',
    username: ADMIN_USER,
    password: ADMIN_PASSWORD,
  }),
});
if (!tok.ok) throw new Error(`bootstrap admin token: ${tok.status}`);
const { access_token } = await tok.json();
const headers = { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' };
const admin = `${KC}/admin/realms/${encodeURIComponent(targetRealm)}`;
const api = async (method, path, body) => {
  const res = await fetch(`${admin}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  }
  return res;
};
const getClient = async (clientId) =>
  (await (await api('GET', `/clients?clientId=${encodeURIComponent(clientId)}`)).json())[0];
const getSaUser = async (client) =>
  (await api('GET', `/clients/${client.id}/service-account-user`)).json();

for (const clientId of wantedIds) {
  const wanted = declared.find((c) => c.clientId === clientId);
  const wantedUser = exportFile.users.find((u) => u.serviceAccountClientId === clientId);

  // 1. The client and its service-account user, exactly as exported (the export is the source of truth).
  let client = await getClient(clientId);
  if (client) {
    console.info(`${clientId}: exists in realm ${targetRealm} (id ${client.id}) — left as is`);
  } else {
    // partialImport honours the user's fixed id; the client must come first (SKIP: never overwrite a client).
    const res = await api('POST', '/partialImport', {
      ifResourceExists: 'SKIP',
      clients: [wanted],
      ...(wantedUser ? { users: [wantedUser] } : {}),
    });
    if (!res.ok) throw new Error(`partialImport ${clientId}: ${res.status}`);
    client = await getClient(clientId);
    if (!client) throw new Error(`${clientId}: not found after partialImport`);
    console.info(`${clientId}: created in realm ${targetRealm} (id ${client.id})`);
  }

  // 2. The service-account user's id: the export's fixed id when it declares one.
  let saUser = await getSaUser(client);
  if (wantedUser?.id && saUser.id !== wantedUser.id) {
    // Keycloak made its own service-account user (random id) when the client was created. Replace exactly that
    // one user with the export's (same username, the export's id) — nothing else is overwritten.
    const res = await api('POST', '/partialImport', {
      ifResourceExists: 'OVERWRITE',
      users: [wantedUser],
    });
    if (!res.ok) throw new Error(`partialImport user ${wantedUser.username}: ${res.status}`);
    saUser = await getSaUser(client);
    console.info(
      `${clientId}: service-account user id ${saUser.id === wantedUser.id ? 'set to' : 'STILL NOT'} ${wantedUser.id}`,
    );
    if (saUser.id !== wantedUser.id) process.exitCode = 1;
  } else {
    console.info(`${clientId}: service-account user ${saUser.username} (id ${saUser.id})`);
  }

  // 3. Realm-management role mappings, only when the export declares some (core-admin); none for the others.
  const wantedRoles = wantedUser?.clientRoles?.['realm-management'] ?? [];
  const [rm] = await (await api('GET', `/clients?clientId=realm-management`)).json();
  const current = await (
    await api('GET', `/users/${saUser.id}/role-mappings/clients/${rm.id}`)
  ).json();
  const have = new Set(current.map((r) => r.name));
  if (wantedRoles.some((n) => !have.has(n))) {
    const available = await (
      await api('GET', `/users/${saUser.id}/role-mappings/clients/${rm.id}/available`)
    ).json();
    const toAdd = wantedRoles
      .filter((n) => !have.has(n))
      .map((n) => available.find((r) => r.name === n));
    if (toAdd.some((r) => !r))
      throw new Error(`realm-management lacks a wanted role: ${wantedRoles.join(', ')}`);
    const res = await api('POST', `/users/${saUser.id}/role-mappings/clients/${rm.id}`, toAdd);
    if (res.status !== 204) throw new Error(`add role mappings: ${res.status}`);
  }
  const after = (
    await (await api('GET', `/users/${saUser.id}/role-mappings/clients/${rm.id}`)).json()
  )
    .map((r) => r.name)
    .sort();
  const extra = after.filter((n) => !wantedRoles.includes(n));
  console.info(
    `${clientId}: realm-management roles [${after.join(', ')}]` +
      (extra.length
        ? ` — EXTRA roles not in the export, left for a human: ${extra.join(', ')}`
        : ''),
  );
}
