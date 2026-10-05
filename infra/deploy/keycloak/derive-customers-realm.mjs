#!/usr/bin/env node
/**
 * Derives the DEPLOYED customers realm from the dev export (#297).
 *
 *   node infra/deploy/keycloak/derive-customers-realm.mjs                # print the derived realm
 *   node infra/deploy/keycloak/derive-customers-realm.mjs --out <file>   # write it to <file>
 *
 * `infra/keycloak/customers-realm.json` is window 2's file and the single source: the local stack
 * imports it as it is, test client, seeded customer and localhost URIs included. A deployed realm must
 * not carry any of those, so it is GENERATED from the export here rather than kept by hand next to it —
 * two hand-kept realms drift, and the drift is a security bug. This script only reads the export; it
 * never writes under infra/keycloak/.
 *
 * What changes, and why:
 *   - the `test-cli` client goes: it allows direct access grants (passwords posted straight to the
 *     token endpoint), which exist for the live test suites only;
 *   - every user goes: `jane@example.com` and any other seeded customer are test fixtures;
 *   - every http://localhost / 127.0.0.1 URI goes — redirect URIs, web origins, post-logout URIs,
 *     root/base/admin URLs, and the realm's `frontendUrl` (the deployment sets its own hostname). A
 *     storefront client left with no redirect URI at all (a brand not deployed yet) is dropped and named;
 *   - `verifyEmail: true`: the core links guest orders to a customer only on a verified email (#307);
 *   - identity providers get `trustEmail: false`, and no flow may auto-link a broker login to an
 *     existing account (#297, window 2's reading of first-broker-login): an attacker who pre-registers
 *     a victim's address must not end up owning the account once the victim signs in through Google.
 *
 * `deployableViolations(realm)` is the gate: the derived realm must have none, and
 * derive-customers-realm.test.mjs proves each rule fails when its violation is put back.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SOURCE = join(ROOT, 'infra', 'keycloak', 'customers-realm.json');

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;
const isLocal = (uri) => typeof uri === 'string' && LOCAL.test(uri.trim());
/** Authenticators that link a brokered identity to an existing user without proof of ownership. */
const AUTO_LINK = new Set(['idp-auto-link']);
const POST_LOGOUT = 'post.logout.redirect.uris';

/** Returns a new realm; the input is not modified. */
export function derive(source) {
  const realm = globalThis.structuredClone(source);
  const notes = [];

  realm.verifyEmail = true;
  delete realm.users;
  if (realm.attributes) delete realm.attributes.frontendUrl;

  realm.clients = (realm.clients ?? []).filter((client) => {
    if (client.clientId === 'test-cli') {
      notes.push('dropped client test-cli (direct access grants, test suites only)');
      return false;
    }
    client.redirectUris = (client.redirectUris ?? []).filter((u) => !isLocal(u));
    client.webOrigins = (client.webOrigins ?? []).filter((u) => !isLocal(u));
    for (const key of ['rootUrl', 'baseUrl', 'adminUrl']) {
      if (isLocal(client[key])) delete client[key];
    }
    if (client.attributes?.[POST_LOGOUT] !== undefined) {
      const kept = client.attributes[POST_LOGOUT].split('##').filter((u) => u && !isLocal(u));
      if (kept.length) client.attributes[POST_LOGOUT] = kept.join('##');
      else delete client.attributes[POST_LOGOUT];
    }
    if (!client.redirectUris.length) {
      notes.push(`dropped client ${client.clientId}: no non-local redirect URI (not deployed yet)`);
      return false;
    }
    return true;
  });

  realm.identityProviders = (realm.identityProviders ?? []).map((idp) => ({
    ...idp,
    trustEmail: false,
  }));
  return { realm, notes };
}

/** Every reason this realm must not be deployed. Empty means deployable. */
export function deployableViolations(realm) {
  const out = [];
  if (realm.verifyEmail !== true) out.push('verifyEmail is not true');
  for (const user of realm.users ?? []) out.push(`user present: ${user.username ?? user.id}`);
  for (const client of realm.clients ?? []) {
    if (client.clientId === 'test-cli') out.push('client test-cli present');
  }
  // Any localhost URI anywhere — walked generically, so a new field that carries one is caught too.
  const walk = (value, path) => {
    if (typeof value === 'string') {
      for (const part of value.split('##')) {
        if (isLocal(part)) out.push(`local URI at ${path}: ${part}`);
      }
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(realm, '');
  for (const idp of realm.identityProviders ?? []) {
    if (idp.trustEmail === true) out.push(`identity provider ${idp.alias}: trustEmail is true`);
  }
  for (const flow of realm.authenticationFlows ?? []) {
    for (const step of flow.authenticationExecutions ?? []) {
      if (AUTO_LINK.has(step.authenticator)) {
        out.push(`flow ${flow.alias}: auto-link step ${step.authenticator}`);
      }
    }
  }
  return out;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const outIdx = process.argv.indexOf('--out');
  const { realm, notes } = derive(JSON.parse(readFileSync(SOURCE, 'utf8')));
  for (const note of notes) console.error(`derive: ${note}`);
  const violations = deployableViolations(realm);
  if (violations.length) {
    for (const v of violations) console.error(`derive: NOT deployable — ${v}`);
    process.exit(1);
  }
  const json = `${JSON.stringify(realm, null, 2)}\n`;
  if (outIdx > -1 && process.argv[outIdx + 1]) writeFileSync(process.argv[outIdx + 1], json);
  else process.stdout.write(json);
}
