// Self-test for derive-customers-realm.mjs (#297). Runs in CI's `helm` job:
//
//   node --test infra/deploy/keycloak/
//
// Two halves. The real export derives to a realm with no violations, without touching the export.
// Then every rule is MUTATION-TESTED: each violation is put back into an otherwise clean derived
// realm, one at a time, and the gate must name it. A rule that cannot fail is not a rule.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SOURCE, deployableViolations, derive } from './derive-customers-realm.mjs';

const exportText = readFileSync(SOURCE, 'utf8');
const source = JSON.parse(exportText);
const clean = () => derive(JSON.parse(exportText)).realm;

test('the dev export itself is NOT deployable (the gate sees what the derivation removes)', () => {
  const v = deployableViolations(source);
  assert.ok(
    v.some((x) => x.includes('test-cli')),
    v.join('\n'),
  );
  assert.ok(
    v.some((x) => x.startsWith('user present')),
    v.join('\n'),
  );
  assert.ok(
    v.some((x) => x.startsWith('local URI')),
    v.join('\n'),
  );
  assert.ok(v.includes('verifyEmail is not true'), v.join('\n'));
});

test('the derived realm is deployable', () => {
  assert.deepEqual(deployableViolations(clean()), []);
});

test('deriving does not modify the export', () => {
  derive(source);
  assert.equal(JSON.stringify(source), JSON.stringify(JSON.parse(exportText)));
});

test('brand A keeps its deployed callback, origin and post-logout URIs', () => {
  const client = clean().clients.find((c) => c.clientId === 'storefront-brand-a');
  assert.ok(client, 'storefront-brand-a was dropped');
  assert.ok(client.redirectUris.includes('https://shop.staging.example.com/auth/callback'));
  assert.ok(client.webOrigins.includes('https://shop.staging.example.com'));
  assert.match(
    client.attributes['post.logout.redirect.uris'],
    /https:\/\/shop\.staging\.example\.com\//,
  );
});

/** One mutation per rule: [name, put-the-violation-back, text the gate must report]. */
const MUTATIONS = [
  [
    'a client named test-cli',
    (r) => r.clients.push({ clientId: 'test-cli', redirectUris: [] }),
    'client test-cli present',
  ],
  [
    'a user',
    (r) => (r.users = [{ username: 'jane@example.com' }]),
    'user present: jane@example.com',
  ],
  [
    'a localhost redirect URI',
    (r) => r.clients[0].redirectUris.push('http://localhost:3101/*'),
    'local URI',
  ],
  [
    'a 127.0.0.1 redirect URI',
    (r) => r.clients[0].redirectUris.push('http://127.0.0.1:3101/*'),
    'local URI',
  ],
  [
    'a localhost web origin',
    (r) => r.clients[0].webOrigins.push('http://localhost:3101'),
    'local URI',
  ],
  [
    'a localhost post-logout URI',
    (r) => (r.clients[0].attributes['post.logout.redirect.uris'] += '##http://localhost:3101/*'),
    'local URI',
  ],
  ['a localhost rootUrl', (r) => (r.clients[0].rootUrl = 'http://localhost:3100'), 'local URI'],
  [
    'a localhost frontendUrl',
    (r) => (r.attributes.frontendUrl = 'http://localhost:8180'),
    'local URI',
  ],
  ['verifyEmail false', (r) => (r.verifyEmail = false), 'verifyEmail is not true'],
  ['verifyEmail missing', (r) => delete r.verifyEmail, 'verifyEmail is not true'],
  [
    'trustEmail true on an identity provider',
    (r) => (r.identityProviders[0].trustEmail = true),
    'trustEmail is true',
  ],
  [
    'an auto-link step in a broker flow',
    (r) =>
      (r.authenticationFlows = [
        {
          alias: 'first broker login',
          authenticationExecutions: [{ authenticator: 'idp-auto-link' }],
        },
      ]),
    'auto-link step idp-auto-link',
  ],
];

for (const [name, mutate, expected] of MUTATIONS) {
  test(`mutation: re-adding ${name} makes the gate fail`, () => {
    const realm = clean();
    mutate(realm);
    const v = deployableViolations(realm);
    assert.ok(
      v.some((x) => x.includes(expected)),
      `expected a violation containing "${expected}", got:\n${v.join('\n') || '(none)'}`,
    );
  });
}
