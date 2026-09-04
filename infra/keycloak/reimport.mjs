#!/usr/bin/env node
/* global URLSearchParams */
// Re-import one realm into the running local Keycloak without restarting the container, or export one.
//   node infra/keycloak/reimport.mjs staff            # delete + create realm from infra/keycloak/staff-realm.json
//   node infra/keycloak/reimport.mjs --export staff   # partial export (no users) to stdout
// Uses the local bootstrap admin (admin/admin from infra/docker/docker-compose.yml). Local dev only.
// Note: ${ENV:default} placeholders in the JSON are resolved only by Keycloak's file import at startup;
// through this path they are stored literally. Finish with a container restart before trusting the result.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const KC = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const ADMIN_USER = process.env.KEYCLOAK_ADMIN ?? 'admin';
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin';

const args = process.argv.slice(2);
const doExport = args.includes('--export');
const realm = args.find((a) => !a.startsWith('--'));
if (!realm) {
  console.error('usage: reimport.mjs [--export] <realm>');
  process.exit(1);
}

async function adminToken() {
  const res = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'admin-cli',
      grant_type: 'password',
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`admin token: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

const token = await adminToken();
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

if (doExport) {
  const res = await fetch(
    `${KC}/admin/realms/${realm}/partial-export?exportClients=true&exportGroupsAndRoles=true`,
    { method: 'POST', headers },
  );
  if (!res.ok) throw new Error(`export: ${res.status} ${await res.text()}`);
  process.stdout.write(JSON.stringify(await res.json(), null, 2) + '\n');
  process.exit(0);
}

const file = resolve(here, `${realm}-realm.json`);
const body = readFileSync(file, 'utf8');
const del = await fetch(`${KC}/admin/realms/${realm}`, { method: 'DELETE', headers });
if (del.status !== 204 && del.status !== 404)
  throw new Error(`delete: ${del.status} ${await del.text()}`);
const create = await fetch(`${KC}/admin/realms`, { method: 'POST', headers, body });
if (create.status !== 201) throw new Error(`create: ${create.status} ${await create.text()}`);
console.info(`realm '${realm}' re-imported from ${file}`);
