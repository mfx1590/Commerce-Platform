#!/usr/bin/env node
// Additive alternative to a realm reimport (issue #483; the owner decides which path the shared stack takes):
//   node infra/keycloak/ensure-service-account.mjs <staff|customers>
// Creates, in the LIVE realm through the admin API, exactly what the realm export declares for the `core-admin`
// service account — the confidential client and its three realm-management role mappings — and nothing else.
// Idempotent: a client that already exists is left as it is (reported), missing role mappings are added, extra
// ones are reported, never removed. No realm delete, no reimport: every other client, user and session of the
// realm stays untouched. Bootstrap admin from the environment (KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD, dev
// defaults), like reimport.mjs. Prints ids and role names only — never the secret.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URLSearchParams } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const KC = (process.env.KEYCLOAK_URL ?? 'http://localhost:8180').replace(/\/+$/, '');
const ADMIN_USER = process.env.KEYCLOAK_ADMIN ?? 'admin';
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin';
const [realm] = process.argv.slice(2);
if (!['staff', 'customers'].includes(realm)) {
  console.error('usage: node infra/keycloak/ensure-service-account.mjs <staff|customers>');
  process.exit(1);
}

const exportFile = JSON.parse(readFileSync(resolve(here, `${realm}-realm.json`), 'utf8'));
const wanted = exportFile.clients.find((c) => c.clientId === 'core-admin');
const wantedUser = exportFile.users.find((u) => u.serviceAccountClientId === 'core-admin');
if (!wanted || !wantedUser) {
  console.error(`${realm}-realm.json declares no core-admin service account — nothing to ensure`);
  process.exit(1);
}
const wantedRoles = wantedUser.clientRoles?.['realm-management'] ?? [];

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
const admin = `${KC}/admin/realms/${realm}`;
const api = async (method, path, body) => {
  const res = await fetch(`${admin}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok && res.status !== 404)
    throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res;
};

// 1. The client, exactly as exported (the export is the source of truth; nothing is edited here).
let [client] = await (await api('GET', `/clients?clientId=core-admin`)).json();
if (client) {
  console.info(`core-admin exists in realm ${realm} (id ${client.id}) — left as is`);
} else {
  const created = await api('POST', '/clients', wanted);
  if (created.status !== 201) throw new Error(`create client: ${created.status}`);
  [client] = await (await api('GET', `/clients?clientId=core-admin`)).json();
  console.info(`core-admin created in realm ${realm} (id ${client.id})`);
}

// 2. Its service-account user and the realm-management role mappings.
const saUser = await (await api('GET', `/clients/${client.id}/service-account-user`)).json();
const [rm] = await (await api('GET', `/clients?clientId=realm-management`)).json();
const available = await (
  await api('GET', `/users/${saUser.id}/role-mappings/clients/${rm.id}/available`)
).json();
const current = await (
  await api('GET', `/users/${saUser.id}/role-mappings/clients/${rm.id}`)
).json();
const have = new Set(current.map((r) => r.name));
const toAdd = wantedRoles
  .filter((n) => !have.has(n))
  .map((n) => available.find((r) => r.name === n));
if (toAdd.some((r) => !r))
  throw new Error(`realm-management lacks a wanted role: ${wantedRoles.join(', ')}`);
if (toAdd.length > 0) {
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
  `service account ${saUser.username}: realm-management roles now [${after.join(', ')}]` +
    (toAdd.length ? ` (added ${toAdd.map((r) => r.name).join(', ')})` : ' (nothing added)') +
    (extra.length ? ` — EXTRA roles not in the export, left for a human: ${extra.join(', ')}` : ''),
);
