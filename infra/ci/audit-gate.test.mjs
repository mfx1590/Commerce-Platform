// Self-test for audit-gate.mjs (#730). Runs in the `changes` job:  node --test infra/ci/audit-gate.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_ALLOWLIST, advisoriesOf, evaluate, render } from './audit-gate.mjs';

const adv = (id, pkg, severity, app = 'apps__core') => ({
  id: Math.floor(Math.random() * 1e6),
  github_advisory_id: id,
  module_name: pkg,
  severity,
  title: `${pkg} issue`,
  url: `https://github.com/advisories/${id}`,
  findings: [{ version: '1.0.0', paths: [`${app}>x>${pkg}`] }],
});
const report = (...advs) => ({
  actions: [],
  advisories: Object.fromEntries(advs.map((a, i) => [String(i), a])),
  muted: [],
  metadata: { vulnerabilities: {} },
});
const TODAY = '2026-11-06';
const LIST = (entries, threshold = 'high') => ({ threshold, entries });

test('a high advisory not on the allow-list fails', () => {
  const r = evaluate(advisoriesOf(report(adv('GHSA-aaaa', 'evil', 'high'))), LIST([]), TODAY);
  assert.equal(r.ok, false);
  assert.match(r.failures[0].reason, /not on the allow-list/);
  assert.deepEqual(r.failures[0].apps, ['apps/core']);
});

test('a critical one fails too; moderate and low are only counted', () => {
  const r = evaluate(
    advisoriesOf(
      report(
        adv('GHSA-c', 'a', 'critical'),
        adv('GHSA-m', 'b', 'moderate'),
        adv('GHSA-l', 'c', 'low'),
      ),
    ),
    LIST([]),
    TODAY,
  );
  assert.deepEqual(
    r.failures.map((f) => f.id),
    ['GHSA-c'],
  );
  assert.deepEqual(r.below, { moderate: 1, low: 1 });
});

test('an allow-listed advisory in date passes; on its expiry day it still passes; the day after it fails', () => {
  const advs = advisoriesOf(report(adv('GHSA-aaaa', 'evil', 'high')));
  const list = LIST([
    { id: 'GHSA-aaaa', package: 'evil', expires: '2026-11-20', owner: 'window 1' },
  ]);
  assert.equal(evaluate(advs, list, TODAY).ok, true);
  assert.equal(evaluate(advs, list, '2026-11-20').ok, true);
  const late = evaluate(advs, list, '2026-11-21');
  assert.equal(late.ok, false);
  assert.match(late.failures[0].reason, /expired 2026-11-20/);
});

test('an entry without an expiry date never allows anything', () => {
  const r = evaluate(
    advisoriesOf(report(adv('GHSA-aaaa', 'evil', 'high'))),
    LIST([{ id: 'GHSA-aaaa', package: 'evil' }]),
    TODAY,
  );
  assert.equal(r.ok, false);
});

test('the threshold is one setting: at "critical", a high is only counted', () => {
  const r = evaluate(advisoriesOf(report(adv('GHSA-h', 'a', 'high'))), LIST([], 'critical'), TODAY);
  assert.equal(r.ok, true);
  assert.deepEqual(r.below, { high: 1 });
});

test('an entry that matches no advisory is reported as stale, not failed', () => {
  const r = evaluate(
    advisoriesOf(report()),
    LIST([{ id: 'GHSA-gone', package: 'old', expires: '2026-12-01' }]),
    TODAY,
  );
  assert.equal(r.ok, true);
  assert.equal(r.stale[0].id, 'GHSA-gone');
  assert.match(render(r, TODAY), /stale {3}GHSA-gone/);
});

test('a report that is not a pnpm audit report fails closed', () => {
  assert.throws(
    () => advisoriesOf({ error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE' } }),
    /advisory lookup failed/,
  );
  assert.throws(() => advisoriesOf(null), /advisory lookup failed/);
});

test('an unknown threshold is refused', () => {
  assert.throws(() => evaluate([], LIST([], 'severe'), TODAY), /unknown threshold/);
});

test('the committed allow-list is well-formed: threshold known, every entry has id, package, owner, reason and a date', () => {
  const list = JSON.parse(readFileSync(DEFAULT_ALLOWLIST, 'utf8'));
  assert.ok(['low', 'moderate', 'high', 'critical'].includes(list.threshold));
  for (const e of list.entries) {
    assert.match(e.id, /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/, JSON.stringify(e));
    assert.ok(e.package && e.owner && e.reason, JSON.stringify(e));
    assert.match(e.expires, /^\d{4}-\d{2}-\d{2}$/, JSON.stringify(e));
  }
});
