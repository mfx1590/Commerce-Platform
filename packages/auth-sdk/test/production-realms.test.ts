// Derived production realm exports (issue #416, LAUNCH.md section 3.2). Static, always runs: re-derives each
// production file from the dev export + production.config.json and compares byte for byte (a hand edit of
// infra/keycloak/production/*.json fails here), proves the derivation is deterministic, and asserts every
// invariant of the "Dev-only settings" table as its own assertion.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  deriveProductionRealm,
  loadConfig,
  loadDevRealm,
  outputPath,
  renderRealm,
  REALMS,
} from '../../../infra/keycloak/derive-production.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const devDir = resolve(here, '../../../infra/keycloak');

interface Client {
  clientId: string;
  publicClient?: boolean;
  secret?: string;
  rootUrl?: string;
  redirectUris?: string[];
  webOrigins?: string[];
  attributes?: Record<string, string>;
  serviceAccountsEnabled?: boolean;
  directAccessGrantsEnabled?: boolean;
}
interface Realm {
  realm: string;
  sslRequired: string;
  verifyEmail: boolean;
  passwordPolicy?: string;
  bruteForceProtected: boolean;
  attributes: Record<string, string>;
  users: {
    username: string;
    email?: string;
    credentials?: unknown[];
    serviceAccountClientId?: string;
  }[];
  clients: Client[];
  identityProviders?: { alias: string; enabled: boolean; config: Record<string, string> }[];
  authenticationFlows?: {
    alias: string;
    authenticationExecutions: { authenticator?: string; flowAlias?: string; requirement: string }[];
  }[];
}

const config = loadConfig() as {
  keycloakUrl: string;
  realms: Record<
    string,
    { passwordPolicy: string; clients: Record<string, { origin: string; callback: string }> }
  >;
};
const production = Object.fromEntries(
  REALMS.map((realm) => [realm, JSON.parse(readFileSync(outputPath(realm), 'utf8')) as Realm]),
) as Record<string, Realm>;

describe('production realm exports are derived, not written (#416)', () => {
  it.each(REALMS)(
    '%s: the committed file equals a fresh derivation byte for byte',
    async (realm) => {
      const fresh = await renderRealm(deriveProductionRealm(realm, loadDevRealm(realm), config));
      expect(readFileSync(outputPath(realm), 'utf8')).toBe(fresh);
    },
  );

  it.each(REALMS)('%s: two derivations are identical (deterministic)', async (realm) => {
    const a = await renderRealm(deriveProductionRealm(realm, loadDevRealm(realm), config));
    const b = await renderRealm(deriveProductionRealm(realm, loadDevRealm(realm), config));
    expect(a).toBe(b);
  });

  it('a hand edit of a derived file is detected (the comparison is not a no-op)', async () => {
    const fresh = await renderRealm(deriveProductionRealm('staff', loadDevRealm('staff'), config));
    const edited = fresh.replace('"sslRequired": "all"', '"sslRequired": "external"');
    expect(edited).not.toBe(fresh);
    expect(readFileSync(outputPath('staff'), 'utf8')).not.toBe(edited);
  });

  it('nothing but realm exports at the top level of infra/keycloak (the docker startup import treats every top-level *.json as a realm)', () => {
    const topLevel = readdirSync(devDir).filter((f) => f.endsWith('.json'));
    expect(topLevel.sort()).toEqual(['customers-realm.json', 'staff-realm.json']);
    for (const f of topLevel) {
      const parsed = JSON.parse(readFileSync(resolve(devDir, f), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(typeof parsed.realm, f).toBe('string');
      expect(
        parsed._comment,
        `${f}: a root _comment is an unrecognized field for Keycloak`,
      ).toBeUndefined();
    }
    // The derived files and the profile live one level down, which the startup import does not scan.
    expect(readdirSync(resolve(devDir, 'production')).sort()).toEqual([
      'customers-realm.json',
      'production-profile.json',
      'staff-realm.json',
    ]);
  });

  it('the dev exports are untouched: still localhost, test-cli, seeded users', () => {
    const staff = JSON.parse(readFileSync(resolve(devDir, 'staff-realm.json'), 'utf8')) as Realm;
    expect(staff.sslRequired).toBe('external');
    expect(staff.clients.map((c) => c.clientId)).toContain('test-cli');
    expect(staff.users.filter((u) => !u.serviceAccountClientId).length).toBeGreaterThan(0);
  });
});

describe.each(REALMS)('production %s realm invariants', (realm) => {
  const prod = production[realm]!;
  const every = (f: (c: Client) => string[]) => prod.clients.flatMap(f);

  it('no seeded user: only client service accounts remain (no credentials, no email)', () => {
    for (const u of prod.users) {
      expect(u.serviceAccountClientId, u.username).toBeDefined();
      expect(u.credentials, u.username).toBeUndefined();
      expect(u.email, u.username).toBeUndefined();
    }
  });
  it('no test-cli client, and no client with the password grant', () => {
    expect(prod.clients.map((c) => c.clientId)).not.toContain('test-cli');
    expect(prod.clients.filter((c) => c.directAccessGrantsEnabled).map((c) => c.clientId)).toEqual(
      [],
    );
  });
  it('no http://localhost anywhere a client points to', () => {
    const all = [
      ...every((c) => c.redirectUris ?? []),
      ...every((c) => c.webOrigins ?? []),
      ...every((c) => (c.rootUrl ? [c.rootUrl] : [])),
      ...every((c) =>
        (c.attributes?.['post.logout.redirect.uris'] ?? '').split('##').filter(Boolean),
      ),
      prod.attributes.frontendUrl!,
    ];
    expect(all.filter((u) => u.includes('localhost'))).toEqual([]);
    expect(all.filter((u) => !u.startsWith('https://'))).toEqual([]);
  });
  it('no wildcard redirect or origin', () => {
    expect(every((c) => c.redirectUris ?? []).filter((u) => u.includes('*'))).toEqual([]);
    expect(every((c) => c.webOrigins ?? []).filter((u) => u.includes('*') || u === '+')).toEqual(
      [],
    );
  });
  it('sslRequired: all', () => expect(prod.sslRequired).toBe('all'));
  it('verifyEmail: true', () => expect(prod.verifyEmail).toBe(true));
  it('a password policy', () =>
    expect(prod.passwordPolicy).toBe(config.realms[realm]!.passwordPolicy));
  it('brute-force protection on', () => expect(prod.bruteForceProtected).toBe(true));
  it('no client secret in the file (the service account secret is generated at import)', () => {
    for (const c of prod.clients) expect(c.secret, c.clientId).toBeUndefined();
  });
  it('frontendUrl is the public Keycloak URL', () =>
    expect(prod.attributes.frontendUrl).toBe(config.keycloakUrl));
  it('identity provider secrets stay environment placeholders', () => {
    for (const idp of prod.identityProviders ?? []) {
      expect(idp.config.clientSecret, idp.alias).toMatch(/^\$\{/);
    }
  });
  it('every OIDC client has exactly the configured callback, origin and post-logout URI', () => {
    for (const [id, target] of Object.entries(config.realms[realm]!.clients)) {
      const c = prod.clients.find((x) => x.clientId === id)!;
      expect(c, id).toBeDefined();
      expect(c.redirectUris).toEqual([target.callback]);
      expect(c.webOrigins).toEqual([target.origin]);
      expect(c.rootUrl).toBe(target.origin);
      expect(c.attributes?.['post.logout.redirect.uris']).toBe(`${target.origin}/`);
    }
  });
});

describe('production customers realm (LAUNCH.md 3.2)', () => {
  it('keeps exactly the three storefront clients with their production callbacks', () => {
    const prod = production.customers!;
    expect(prod.clients.map((c) => c.clientId).sort()).toEqual([
      'storefront-brand-a',
      'storefront-brand-b',
      'storefront-brand-c',
    ]);
    expect(prod.clients.find((c) => c.clientId === 'storefront-brand-a')!.redirectUris).toEqual([
      'https://shop.example.com/auth/callback',
    ]);
  });
});

describe('production staff realm', () => {
  it('forces TOTP enrolment: the OTP step of browser-mfa forms is REQUIRED', () => {
    const prod = production.staff!;
    const forms = prod.authenticationFlows!.find((f) => f.alias === 'browser-mfa forms')!;
    expect(
      forms.authenticationExecutions.map(
        (e) => `${e.flowAlias ?? e.authenticator}:${e.requirement}`,
      ),
    ).toEqual(['auth-username-password-form:REQUIRED', 'browser-mfa otp:REQUIRED']);
  });
  it('keeps admin-app and the core-admin service account (no secret), nothing else', () => {
    const prod = production.staff!;
    expect(prod.clients.map((c) => c.clientId).sort()).toEqual(['admin-app', 'core-admin']);
    expect(prod.users.map((u) => u.serviceAccountClientId)).toEqual(['core-admin']);
  });
});
