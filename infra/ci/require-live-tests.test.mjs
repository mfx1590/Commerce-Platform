// Self-test for require-live-tests.mjs. Runs in the `changes` job:  node --test infra/ci/require-live-tests.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveCounts, liveFailures } from './require-live-tests.mjs';

const T = 'live: real customers-realm tokens through the real verifier';
const report = (...statuses) => ({
  testResults: [
    {
      assertionResults: [
        { ancestorTitles: ['unit block'], status: 'passed' },
        ...statuses.map((status) => ({ ancestorTitles: [T, 'nested'], status })),
      ],
    },
  ],
});

test('every live test passed: no failure', () => {
  assert.deepEqual(liveFailures(liveCounts(report('passed', 'passed'), [T])), []);
});

test('a skipped live block fails (the stack probe missed)', () => {
  const f = liveFailures(liveCounts(report('skipped', 'skipped'), [T]));
  assert.equal(f.length, 1);
  assert.match(f[0], /0\/2 passed/);
});

test('one skipped among passed still fails', () => {
  assert.equal(liveFailures(liveCounts(report('passed', 'skipped'), [T])).length, 1);
});

test('a failed live test fails', () => {
  assert.equal(liveFailures(liveCounts(report('passed', 'failed'), [T])).length, 1);
});

test('a title with no tests under it fails (renamed or never collected)', () => {
  const f = liveFailures(liveCounts(report('passed'), ['no such block']));
  assert.match(f[0], /no tests found/);
});

test('unrelated blocks are not counted', () => {
  assert.equal(liveCounts(report(), [T])[0].total, 0);
});
