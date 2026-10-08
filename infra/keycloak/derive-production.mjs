#!/usr/bin/env node
// Derives the PRODUCTION profile of a realm from its dev export (issue #416, LAUNCH.md section 3.2):
//   node infra/keycloak/derive-production.mjs staff|customers      → infra/keycloak/production/<realm>-realm.json
// Deterministic (same inputs → identical bytes); packages/auth-sdk/test/production-realms.test.ts re-derives
// and compares, so a hand edit of a derived file fails CI. Inputs: the dev export and production.config.json.
// Dev behaviour is untouched: reimport.mjs and the docker startup import read only the dev files in this
// directory (the startup import is not recursive; `production/` is a subdirectory).
//
// What changes (the "Dev-only settings" table of README.md, row by row):
//   sslRequired external → all · verifyEmail → true · a password policy · brute force stays on
//   users: every seeded user removed (only client service accounts stay — no credentials, no email)
//   test-cli removed · core-admin keeps no secret (Keycloak generates one; the operator stores it in Vault)
//   every OIDC client: exactly one callback + one origin from the config, no wildcard, no localhost;
//   post-logout = <origin>/ · rootUrl = origin · attributes.frontendUrl = the public Keycloak URL
//   staff: the OTP step of `browser-mfa forms` CONDITIONAL → REQUIRED (forced enrolment, ADR 0002)
//   identity providers: untouched (disabled placeholders whose secrets resolve from the environment)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import prettier from 'prettier';

export const here = dirname(fileURLToPath(import.meta.url));
export const REALMS = ['staff', 'customers'];

/** Clients that exist only for local development and never reach a production realm. */
const DEV_ONLY_CLIENTS = new Set(['test-cli']);
/** Confidential service accounts: kept, their dev secret dropped (generated at import, stored in Vault). */
const SERVICE_ACCOUNT_CLIENTS = new Set(['core-admin']);

/** Deep copy through JSON: the inputs are JSON documents, and the ESLint env here predates structuredClone. */
const clone = (v) => JSON.parse(JSON.stringify(v));

export function loadDevRealm(realm) {
  return JSON.parse(readFileSync(resolve(here, `${realm}-realm.json`), 'utf8'));
}
export function loadConfig() {
  return JSON.parse(readFileSync(resolve(here, 'production.config.json'), 'utf8'));
}

/**
 * Pure: dev export + config → production realm object. Throws on anything the config does not cover, so a
 * new dev client or realm is a deliberate production decision, never a silent carry-over.
 */
export function deriveProductionRealm(realm, dev, config) {
  const cfg = config.realms?.[realm];
  if (!cfg) throw new Error(`production.config.json has no realm "${realm}"`);
  if (!/^https:\/\/[^/]+$/.test(config.keycloakUrl)) {
    throw new Error('keycloakUrl must be an https origin without a path');
  }
  const out = clone(dev);

  out.sslRequired = 'all';
  out.verifyEmail = true;
  out.bruteForceProtected = true;
  if (!cfg.passwordPolicy) throw new Error(`realms.${realm}.passwordPolicy is required`);
  out.passwordPolicy = cfg.passwordPolicy;
  out.attributes = {
    ...out.attributes,
    _comment: `PRODUCTION profile of the ${realm} realm, DERIVED by infra/keycloak/derive-production.mjs from ${realm}-realm.json + production.config.json — never edit by hand (the invariants test re-derives and compares). Needs at import time: SMTP (smtpServer), the identity providers' secrets from the environment, and the core-admin client secret stored in Vault after Keycloak generated it.`,
    frontendUrl: config.keycloakUrl,
  };

  // Users: only client service accounts survive (no credentials, no email); every seeded person goes.
  out.users = (dev.users ?? []).filter((u) => u.serviceAccountClientId);

  // Clients.
  out.clients = [];
  for (const c of dev.clients) {
    if (DEV_ONLY_CLIENTS.has(c.clientId)) continue;
    const client = clone(c);
    if (SERVICE_ACCOUNT_CLIENTS.has(c.clientId)) {
      delete client.secret;
      out.clients.push(client);
      continue;
    }
    const target = cfg.clients?.[c.clientId];
    if (!target)
      throw new Error(
        `production.config.json: realms.${realm}.clients has no entry for "${c.clientId}"`,
      );
    for (const [k, v] of Object.entries(target)) {
      if (!/^https:\/\/[^/]+(\/[^*?#]*)?$/.test(v))
        throw new Error(`${c.clientId}.${k} must be an exact https URL`);
    }
    if (!target.callback.startsWith(`${target.origin}/`)) {
      throw new Error(`${c.clientId}: callback must be on its origin`);
    }
    client.rootUrl = target.origin;
    client.baseUrl = '/';
    client.redirectUris = [target.callback];
    client.webOrigins = [target.origin];
    client.attributes = {
      ...client.attributes,
      'post.logout.redirect.uris': `${target.origin}/`,
    };
    out.clients.push(client);
  }
  const configured = Object.keys(cfg.clients ?? {});
  const present = out.clients.map((c) => c.clientId);
  for (const id of configured) {
    if (!present.includes(id))
      throw new Error(
        `production.config.json configures "${id}" which the ${realm} dev export does not have`,
      );
  }

  // Staff: forced TOTP enrolment — the dev-only CONDITIONAL step becomes REQUIRED.
  if (realm === 'staff') {
    const forms = (out.authenticationFlows ?? []).find((f) => f.alias === 'browser-mfa forms');
    const otp = forms?.authenticationExecutions.find((e) => e.flowAlias === 'browser-mfa otp');
    if (!otp)
      throw new Error('staff realm: browser-mfa forms / browser-mfa otp execution not found');
    otp.requirement = 'REQUIRED';
  }
  return out;
}

export async function renderRealm(obj) {
  const config = (await prettier.resolveConfig(here)) ?? {};
  return prettier.format(JSON.stringify(obj, null, 2) + '\n', { ...config, parser: 'json' });
}

export function outputPath(realm) {
  return resolve(here, 'production', `${realm}-realm.json`);
}

async function main() {
  const [realm] = process.argv.slice(2);
  if (!REALMS.includes(realm)) {
    console.error(`usage: node infra/keycloak/derive-production.mjs <${REALMS.join('|')}>`);
    process.exit(1);
  }
  const text = await renderRealm(deriveProductionRealm(realm, loadDevRealm(realm), loadConfig()));
  mkdirSync(resolve(here, 'production'), { recursive: true });
  writeFileSync(outputPath(realm), text);
  console.info(`derived infra/keycloak/production/${realm}-realm.json (${text.length} bytes)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
