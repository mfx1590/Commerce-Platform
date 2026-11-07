// Self-test for drill.mjs (#741). Runs in the `changes` job:  node --test infra/dr/drill.test.mjs
// The drill itself needs Docker and the shared stack; these are the parts that decide whether it is safe and right.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  DRILL_COMPOSE,
  DRILL_PORTS,
  DRILL_PROJECT,
  SHARED_COMPOSE,
  SHARED_PROJECT,
  chOrder,
  composeHostPorts,
  diff,
  dockerHostPorts,
  rpoSeconds,
  tuplesDigest,
} from './drill.mjs';

const drill = readFileSync(DRILL_COMPOSE, 'utf8');
const shared = readFileSync(SHARED_COMPOSE, 'utf8');

test('the drill stack is its own project: name, ports and volumes never the shared stack’s', () => {
  assert.notEqual(DRILL_PROJECT, SHARED_PROJECT);
  assert.match(drill, new RegExp(`^name: ${DRILL_PROJECT}$`, 'm'));
  const drillPorts = composeHostPorts(drill);
  assert.deepEqual([...drillPorts].sort(), Object.values(DRILL_PORTS).sort());
  const sharedPorts = new Set(composeHostPorts(shared));
  assert.ok(sharedPorts.size >= 10, `parsed only ${sharedPorts.size} shared ports`);
  assert.deepEqual(
    drillPorts.filter((p) => sharedPorts.has(p)),
    [],
  );
  for (const p of drillPorts) assert.ok(p > 15000, `${p}: WinNAT reserves blocks below 15000`);
  // loopback only, named volumes of its own, nothing external
  assert.equal((drill.match(/- '127\.0\.0\.1:\d+:\d+'/g) ?? []).length, drillPorts.length);
  assert.doesNotMatch(drill, /external:/);
  const volumes = [...drill.matchAll(/^\s+- (dr-[a-z-]+):\//gm)].map((m) => m[1]);
  assert.equal(volumes.length, 3);
  const sharedVolumes = [...shared.matchAll(/^ {2}([a-z-]+-data):$/gm)].map((m) => m[1]);
  assert.deepEqual(
    volumes.filter((v) => sharedVolumes.includes(v)),
    [],
  );
});

test('docker ps port parsing finds every published host port', () => {
  assert.deepEqual(
    dockerHostPorts('0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp\n127.0.0.1:18123->8123/tcp\n'),
    [5433, 5433, 18123],
  );
});

test('diff names every mismatch with its path, and nothing when equal', () => {
  const a = {
    tables: { 'public.a': 3, 'public.b': 1 },
    perTenant: { 'public.a.store_id': { s1: 2, s2: 1 } },
  };
  assert.deepEqual(diff(a, JSON.parse(JSON.stringify(a))), []);
  const b = JSON.parse(JSON.stringify(a));
  b.perTenant['public.a.store_id'].s2 = 0;
  delete b.tables['public.b'];
  assert.deepEqual(diff(a, b), [
    'perTenant.public.a.store_id.s2: expected 1, got 0',
    'tables.public.b: expected 1, got undefined',
  ]);
});

test('ClickHouse restores data tables first, views next, materialized views last; an unknown engine is refused', () => {
  const order = chOrder([
    { name: 'mv_x', engine: 'MaterializedView' },
    { name: 'v', engine: 'View' },
    { name: 'raw_events', engine: 'ReplacingMergeTree' },
    { name: 'target', engine: 'MergeTree' },
  ]);
  assert.deepEqual(order, { data: ['raw_events', 'target'], views: ['v'], mvs: ['mv_x'] });
  assert.throws(() => chOrder([{ name: 'k', engine: 'Kafka' }]), /no restore path/);
});

test('RPO is backup start minus the newest restored row; nothing restored means no number', () => {
  assert.equal(
    rpoSeconds('2026-11-07T10:00:00.000Z', [
      '2026-11-07T09:58:30.000Z',
      null,
      '2026-11-07T09:00:00Z',
    ]),
    90,
  );
  assert.equal(rpoSeconds('2026-11-07T10:00:00.000Z', [null]), null);
});

test('the tuple digest ignores order and sees a changed tuple', () => {
  const k = [
    { user: 'user:a', relation: 'admin', object: 'store:1' },
    { user: 'user:b', relation: 'staff', object: 'store:1' },
  ];
  assert.deepEqual(tuplesDigest(k), tuplesDigest([...k].reverse()));
  assert.notEqual(tuplesDigest(k).md5, tuplesDigest([k[0], { ...k[1], relation: 'admin' }]).md5);
});
