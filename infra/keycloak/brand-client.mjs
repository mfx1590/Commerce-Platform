/**
 * The ONE definition of a brand storefront's client in the customers realm (wave 3, brand D).
 *
 * `brandClient({ code, ports, hosts })` is the template behind every `storefront-<code>` client:
 * brand-a/b/c in customers-realm.json are exactly its output (brand-client.test.mjs proves it byte for
 * byte), and add-brand-client.mjs creates a new brand's client from it. A change to how a brand client
 * looks is a change here, and the test then says which realm-file clients no longer match.
 *
 *   code   the brand's registry code ('brand-d'): clientId `storefront-<code>`, the `store_code` claim
 *   ports  its local dev port(s): http://localhost:<port>/* redirects + origins
 *   hosts  extra https hosts (brand A keeps the shop.dev/staging placeholders): <host>/auth/callback
 *
 * Pure: no I/O, no Keycloak. Plain JS so the `changes` job self-tests it without a pnpm install.
 */

export const REALM = 'customers';
export const CODE_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

const tokenClaims = {
  'id.token.claim': 'true',
  'access.token.claim': 'true',
  'userinfo.token.claim': 'true',
  'introspection.token.claim': 'true',
};

/** The client representation, in the realm file's key order. */
export function brandClient({ code, ports, hosts = [] }) {
  if (!CODE_RE.test(code ?? ''))
    throw new Error(`brand code must be lower-case kebab (e.g. brand-d), got "${code}"`);
  if (
    !Array.isArray(ports) ||
    ports.length === 0 ||
    !ports.every((p) => Number.isInteger(p) && p > 0 && p < 65536)
  )
    throw new Error(`ports must be a non-empty list of TCP ports, got ${JSON.stringify(ports)}`);
  for (const h of hosts)
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h))
      throw new Error(`hosts are bare DNS names (no scheme, no path), got "${h}"`);
  const local = ports.map((p) => `http://localhost:${p}`);
  const remote = hosts.map((h) => `https://${h}`);
  return {
    clientId: `storefront-${code}`,
    name: `Storefront ${code}`,
    enabled: true,
    publicClient: true,
    protocol: 'openid-connect',
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    consentRequired: false,
    fullScopeAllowed: true,
    rootUrl: local[0],
    baseUrl: '/',
    redirectUris: [...local.map((o) => `${o}/*`), ...remote.map((o) => `${o}/auth/callback`)],
    webOrigins: [...local, ...remote],
    attributes: {
      'pkce.code.challenge.method': 'S256',
      'post.logout.redirect.uris': [
        ...local.map((o) => `${o}/*`),
        ...remote.map((o) => `${o}/`),
      ].join('##'),
      'use.refresh.tokens': 'true',
    },
    defaultClientScopes: ['openid', 'profile', 'email', 'roles', 'web-origins', 'basic'],
    optionalClientScopes: ['offline_access'],
    protocolMappers: [
      {
        name: 'email',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-usermodel-property-mapper',
        consentRequired: false,
        config: {
          'user.attribute': 'email',
          'claim.name': 'email',
          'jsonType.label': 'String',
          ...tokenClaims,
        },
      },
      {
        name: 'email verified',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-usermodel-property-mapper',
        consentRequired: false,
        config: {
          'user.attribute': 'emailVerified',
          'claim.name': 'email_verified',
          'jsonType.label': 'boolean',
          ...tokenClaims,
        },
      },
      {
        name: 'store code',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-hardcoded-claim-mapper',
        consentRequired: false,
        config: {
          'claim.name': 'store_code',
          'claim.value': code,
          'jsonType.label': 'String',
          'id.token.claim': 'true',
          'access.token.claim': 'true',
          'userinfo.token.claim': 'false',
          'introspection.token.claim': 'true',
        },
      },
      {
        // the core-api audience: the core accepts only tokens minted for it
        name: 'audience core-api',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
        consentRequired: false,
        config: {
          'included.custom.audience': 'core-api',
          'id.token.claim': 'false',
          'access.token.claim': 'true',
          'introspection.token.claim': 'true',
        },
      },
    ],
  };
}

/** The production profile entry (production/production-profile.json) for a brand's client. */
export function profileEntry(origin) {
  if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/.test(origin))
    throw new Error(`origin must be https://<host>, got "${origin}"`);
  return { origin, callback: `${origin}/auth/callback` };
}

/**
 * What differs between the template and a live client (GET /admin/realms/customers/clients/{id}, plus its
 * default/optional scope names). Only the template's own fields are compared: Keycloak adds many attributes
 * and ids of its own, and those are not drift. Returns human-readable lines; [] = no drift.
 */
export function drift(want, live, { defaultScopes = [], optionalScopes = [] } = {}) {
  const out = [];
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const set = (a) => [...new Set(a ?? [])].sort();
  for (const [k, v] of Object.entries(want)) {
    if (
      ['attributes', 'protocolMappers', 'defaultClientScopes', 'optionalClientScopes'].includes(k)
    )
      continue;
    const got = live[k];
    const same = Array.isArray(v) ? eq(set(v), set(got)) : eq(v, got);
    if (!same) out.push(`${k}: want ${JSON.stringify(v)}, live ${JSON.stringify(got)}`);
  }
  for (const [k, v] of Object.entries(want.attributes)) {
    const got = live.attributes?.[k];
    const norm = (s) => (k === 'post.logout.redirect.uris' ? set(String(s ?? '').split('##')) : s);
    if (!eq(norm(v), norm(got)))
      out.push(`attributes.${k}: want ${JSON.stringify(v)}, live ${JSON.stringify(got)}`);
  }
  const liveMappers = new Map((live.protocolMappers ?? []).map((m) => [m.name, m]));
  for (const m of want.protocolMappers) {
    const got = liveMappers.get(m.name);
    if (!got) {
      out.push(`protocolMappers: "${m.name}" missing`);
      continue;
    }
    if (got.protocolMapper !== m.protocolMapper)
      out.push(
        `protocolMappers."${m.name}": type want ${m.protocolMapper}, live ${got.protocolMapper}`,
      );
    for (const [ck, cv] of Object.entries(m.config))
      if (got.config?.[ck] !== cv)
        out.push(
          `protocolMappers."${m.name}".${ck}: want ${JSON.stringify(cv)}, live ${JSON.stringify(got.config?.[ck])}`,
        );
  }
  for (const name of liveMappers.keys())
    if (!want.protocolMappers.some((m) => m.name === name))
      out.push(`protocolMappers: extra "${name}" (not in the template)`);
  if (!eq(set(want.defaultClientScopes), set(defaultScopes)))
    out.push(
      `defaultClientScopes: want ${set(want.defaultClientScopes).join(',')}, live ${set(defaultScopes).join(',')}`,
    );
  if (!eq(set(want.optionalClientScopes), set(optionalScopes)))
    out.push(
      `optionalClientScopes: want ${set(want.optionalClientScopes).join(',')}, live ${set(optionalScopes).join(',')}`,
    );
  return out;
}

/** A brand's dev port from its app: apps/storefronts/<code>/package.json's `dev` script (`--port N`). */
export function devPortFrom(pkg) {
  const m = /--port[ =](\d+)/.exec(pkg?.scripts?.dev ?? '');
  return m ? Number(m[1]) : undefined;
}
