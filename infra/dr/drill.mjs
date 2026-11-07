#!/usr/bin/env node
// The backup + restore drill (#741, plan D5): back up the shared dev stack's state, restore it into a FRESH stack
// (infra/dr/docker-compose.drill.yml, project `commerce-dr`, its own ports and volumes), check that everything came
// back, and time it.
//
//   node infra/dr/drill.mjs all               backup, then restore + check (timed), then teardown (always)
//   node infra/dr/drill.mjs backup            only the backup; prints the folder
//   node infra/dr/drill.mjs restore [<dir>]   restore + check the newest (or the given) backup, then teardown
//   node infra/dr/drill.mjs teardown          `docker compose -p commerce-dr down -v`
//   --keep                                    leave the drill stack up after restore (then `teardown` by hand)
//
// What is backed up (infra/dr/RUNBOOK.md has the why and the numbers):
// - Postgres `platform`: `pg_dump -Fc` INSIDE the container, taken in a snapshot this script holds open, so the
//   expected counts and checksums it computes in that same snapshot are exactly what the dump contains, while the
//   shared stack keeps running. The cluster's roles too (`pg_dumpall --roles-only`): RLS grants name them.
// - ClickHouse `analytics`: SHOW CREATE + `SELECT * … FORMAT Native` per table (a BACKUP TO Disk would need a backups
//   disk in the shared server's config, so a restart of it). Restored tables + data first, views next, materialized
//   views LAST so the inserts do not feed them twice; then `ch:migrate` against the drill applies the access users.
// - Keycloak: the partial export of each realm (the endpoint reimport.mjs --export calls) plus that realm file's users (decision K2:
//   a partial export carries no users, and a second Keycloak JVM inside the shared container is not worth the risk).
// - OpenFGA (in memory in compose, so this export IS its backup): the authorization model and every tuple.
//
// The shared stack is only READ: queries, exports, and two temp files inside its containers' /tmp (removed after).
// Backups land OUTSIDE git: DR_BACKUP_DIR, default C:/Users/mehdi/Desktop/commerce-platform-backups.
//
// Postgres access here is the DB owner's, like pg_dump itself: DR tooling, not an app path through the tenant client.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { URLSearchParams, fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DRILL_COMPOSE = join(ROOT, 'infra/dr/docker-compose.drill.yml');
export const SHARED_COMPOSE = join(ROOT, 'infra/docker/docker-compose.yml');
export const SHARED_PROJECT = 'commerce-platform';
export const DRILL_PROJECT = 'commerce-dr';
export const DRILL_PORTS = { postgres: 25433, clickhouse: 28123, keycloak: 28180, openfga: 28081 };
const DRILL = {
  pg: `postgres://platform:platform@127.0.0.1:${DRILL_PORTS.postgres}/platform`,
  ch: `http://127.0.0.1:${DRILL_PORTS.clickhouse}`,
  kc: `http://127.0.0.1:${DRILL_PORTS.keycloak}`,
  fga: `http://127.0.0.1:${DRILL_PORTS.openfga}`,
};
const REALMS = ['staff', 'customers'];
/** The staff login the check performs (a user of infra/keycloak/staff-realm.json, test-cli = the password-grant client). */
const LOGIN = { realm: 'staff', client: 'test-cli', username: 'store-admin' };
/** Same text for a row on both sides: the session settings row::text depends on. */
const PG_SESSION = [
  "SET LOCAL TimeZone = 'UTC'",
  "SET LOCAL DateStyle = 'ISO, YMD'",
  "SET LOCAL IntervalStyle = 'postgres'",
  'SET LOCAL extra_float_digits = 3',
  "SET LOCAL bytea_output = 'hex'",
];

// ---- pure parts (drill.test.mjs) -------------------------------------------------------------------------------

/** Every difference between what the backup holds and what the restore shows, as "path: expected X, got Y". */
export function diff(expected, actual, path = '') {
  if (
    expected !== null &&
    typeof expected === 'object' &&
    actual !== null &&
    typeof actual === 'object'
  ) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    return keys.flatMap((k) => diff(expected[k], actual[k], path ? `${path}.${k}` : k));
  }
  return expected === actual
    ? []
    : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

/** The ClickHouse restore order: data tables (with their rows) first, then views, materialized views last. */
export function chOrder(tables) {
  const order = { data: [], views: [], mvs: [] };
  for (const t of tables) {
    if (/MergeTree$|^(Log|TinyLog|StripeLog)$/.test(t.engine)) order.data.push(t.name);
    else if (t.engine === 'View') order.views.push(t.name);
    else if (t.engine === 'MaterializedView') order.mvs.push(t.name);
    else
      throw new Error(
        `ClickHouse table ${t.name}: engine ${t.engine} has no restore path in drill.mjs`,
      );
  }
  return order;
}

/** RPO: how much data a restore from this backup would lose at most = backup start − the newest restored row. */
export function rpoSeconds(backupStartedAt, newestRows) {
  const newest = newestRows.filter(Boolean).map((t) => Date.parse(t));
  if (!newest.length) return null;
  return Math.max(0, Math.round((Date.parse(backupStartedAt) - Math.max(...newest)) / 1000));
}

/** Host ports in a compose file's `ports:` entries ('5433:5432', '127.0.0.1:18123:8123'). */
export function composeHostPorts(text) {
  return [...text.matchAll(/^\s*-\s*['"]?(?:[\d.]+:)?(\d+):\d+(?:\/\w+)?['"]?\s*(?:#.*)?$/gm)].map(
    (m) => Number(m[1]),
  );
}

/** Host ports in `docker ps --format {{.Ports}}` output ('0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp'). */
export function dockerHostPorts(text) {
  return [...text.matchAll(/:(\d+)->/g)].map((m) => Number(m[1]));
}

/** A stable digest of a tuple set (order-free). */
export function tuplesDigest(keys) {
  const lines = keys
    .map((k) => `${k.user} ${k.relation} ${k.object} ${k.condition?.name ?? ''}`)
    .sort();
  return { count: lines.length, md5: createHash('md5').update(lines.join('\n')).digest('hex') };
}

// ---- process helpers -------------------------------------------------------------------------------------------

function run(cmd, args, { input, env, allowFail = false, shell = false } = {}) {
  const r = spawnSync(cmd, args, {
    input,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    shell,
  });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(
      `${cmd} ${args.slice(0, 4).join(' ')} … exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 800)}`,
    );
  }
  return r;
}
const docker = (args, opts) => run('docker', args, opts);
/** A path docker.exe takes on Windows (forward slashes; never an MSYS /c/… form). */
const hostPath = (p) => resolve(p).replace(/\\/g, '/');

function container(project, service) {
  const ids = docker([
    'ps',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    `label=com.docker.compose.service=${service}`,
  ])
    .stdout.trim()
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length !== 1)
    throw new Error(`${project}/${service}: expected one running container, found ${ids.length}`);
  return ids[0];
}

function readEnv() {
  const env = {};
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}
const ENV = { ...readEnv(), ...process.env };
const loopback = (url) =>
  url.replace('://localhost', '://127.0.0.1').replace('@localhost:', '@127.0.0.1:');

function pgModule() {
  return createRequire(join(ROOT, 'packages/db/package.json'))('pg');
}

const step = (msg) => console.info(`[drill ${new Date().toISOString().slice(11, 19)}] ${msg}`);

async function http(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body && typeof body === 'object' && !(body instanceof URLSearchParams)
        ? { 'content-type': 'application/json' }
        : {}),
      ...headers,
    },
    body: body instanceof URLSearchParams ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`${method} ${url.replace(/\?.*/, '')}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// ---- Postgres --------------------------------------------------------------------------------------------------

const qi = (s) => `"${s.replace(/"/g, '""')}"`;

/** Counts, per-tenant counts, content checksums, sequences, roles and policies, inside the caller's snapshot. */
async function pgFacts(client) {
  for (const s of PG_SESSION) await client.query(s);
  const { rows: tables } = await client.query(`
    SELECT n.nspname AS schema, c.relname AS name,
      array(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attname IN ('store_id', 'organization_id') ORDER BY 1) AS tenant,
      array(SELECT a.attname::text FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
            WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attname IN ('created_at', 'updated_at') AND t.typname IN ('timestamptz', 'timestamp') ORDER BY 1) AS time
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    ORDER BY 1, 2`);
  const facts = {
    tables: {},
    perTenant: {},
    checksums: {},
    sequences: {},
    roles: [],
    policies: 0,
    newestRowAt: null,
  };
  let newest = null;
  for (const t of tables) {
    const key = `${t.schema}.${t.name}`;
    const rel = `${qi(t.schema)}.${qi(t.name)}`;
    const {
      rows: [r],
    } = await client.query(
      `SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, E'\\n' ORDER BY x::text COLLATE "C"), '')) AS md5 FROM ${rel} x`,
    );
    facts.tables[key] = r.n;
    facts.checksums[key] = r.md5;
    for (const col of t.tenant) {
      const { rows } = await client.query(
        `SELECT coalesce(${qi(col)}::text, 'null') AS k, count(*)::int AS n FROM ${rel} GROUP BY 1 ORDER BY 1`,
      );
      facts.perTenant[`${key}.${col}`] = Object.fromEntries(rows.map((x) => [x.k, x.n]));
    }
    if (t.time.length) {
      const {
        rows: [m],
      } = await client.query(
        `SELECT max(greatest(${t.time.map((c) => `${qi(c)}::timestamptz`).join(', ')})) AS t FROM ${rel}`,
      );
      if (m.t && (!newest || m.t > newest)) newest = m.t;
    }
  }
  const { rows: seqs } = await client.query(
    `SELECT schemaname || '.' || sequencename AS k, coalesce(last_value::text, 'unused') AS v FROM pg_sequences ORDER BY 1`,
  );
  facts.sequences = Object.fromEntries(seqs.map((s) => [s.k, s.v]));
  facts.roles = (
    await client.query(`SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1`)
  ).rows.map((r) => r.rolname);
  facts.policies = (await client.query('SELECT count(*)::int AS n FROM pg_policies')).rows[0].n;
  facts.newestRowAt = newest ? newest.toISOString() : null;
  return facts;
}

async function backupPostgres(dir) {
  const pg = pgModule();
  const ctr = container(SHARED_PROJECT, 'postgres');
  const client = new pg.Client({ connectionString: loopback(ENV.DATABASE_URL) });
  await client.connect();
  mkdirSync(join(dir, 'postgres'), { recursive: true });
  const tmp = ['/tmp/dr-platform.dump', '/tmp/dr-roles.sql'];
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS s')).rows[0].s;
    step(`postgres: pg_dump -Fc in snapshot ${snapshot}`);
    docker([
      'exec',
      ctr,
      'pg_dump',
      '-U',
      'platform',
      '-d',
      'platform',
      '-Fc',
      `--snapshot=${snapshot}`,
      '-f',
      tmp[0],
    ]);
    docker(['exec', ctr, 'pg_dumpall', '-U', 'platform', '--roles-only', '-f', tmp[1]]);
    docker(['cp', `${ctr}:${tmp[0]}`, hostPath(join(dir, 'postgres/platform.dump'))]);
    docker(['cp', `${ctr}:${tmp[1]}`, hostPath(join(dir, 'postgres/roles.sql'))]);
    const size = statSync(join(dir, 'postgres/platform.dump')).size;
    if (size < 1024) throw new Error(`postgres: the copied dump is ${size} bytes`);
    step(
      `postgres: dump copied out (${(size / 1048576).toFixed(1)} MB); expected numbers from the same snapshot`,
    );
    const facts = await pgFacts(client);
    await client.query('COMMIT');
    return { database: 'platform', dumpBytes: size, ...facts };
  } finally {
    await client.end().catch(() => {});
    docker(['exec', ctr, 'rm', '-f', ...tmp], { allowFail: true });
  }
}

async function restorePostgres(dir) {
  const ctr = container(DRILL_PROJECT, 'postgres');
  docker(['cp', hostPath(join(dir, 'postgres/platform.dump')), `${ctr}:/tmp/dr-platform.dump`]);
  docker(['cp', hostPath(join(dir, 'postgres/roles.sql')), `${ctr}:/tmp/dr-roles.sql`]);
  // `platform` exists already (the image's POSTGRES_USER): that one statement fails, the rest apply. The check
  // compares the role list, so a role that did not come back is caught there.
  docker(
    ['exec', ctr, 'psql', '-q', '-U', 'platform', '-d', 'postgres', '-f', '/tmp/dr-roles.sql'],
    { allowFail: true },
  );
  docker([
    'exec',
    ctr,
    'pg_restore',
    '-U',
    'platform',
    '-d',
    'platform',
    '--exit-on-error',
    '/tmp/dr-platform.dump',
  ]);
}

async function checkPostgres() {
  const client = new (pgModule().Client)({ connectionString: DRILL.pg });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const facts = await pgFacts(client);
    await client.query('COMMIT');
    return facts;
  } finally {
    await client.end().catch(() => {});
  }
}

// ---- ClickHouse ------------------------------------------------------------------------------------------------

const CH_DB = 'analytics';
function chq(ctr, sql, user = 'platform', password = 'platform') {
  return docker(
    [
      'exec',
      '-i',
      ctr,
      'clickhouse-client',
      '--user',
      user,
      '--password',
      password,
      '--multiquery',
    ],
    { input: sql },
  ).stdout;
}
const tsv = (out) =>
  out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'));

function chTables(ctr) {
  return tsv(
    chq(
      ctr,
      `SELECT name, engine FROM system.tables WHERE database = '${CH_DB}' AND name != '_migrations_lock' ORDER BY name FORMAT TSV`,
    ),
  ).map(([name, engine]) => ({ name, engine }));
}

/** Rows per table (FINAL for Replacing*: a merge must not change the number), rows per view, events per topic. */
function chFacts(ctr) {
  const tables = chTables(ctr);
  const order = chOrder(tables);
  const facts = { tables: {}, views: {}, topics: {}, newestIngestedAt: null };
  for (const t of tables.filter((x) => order.data.includes(x.name))) {
    const final = /^Replacing|^Collapsing|^VersionedCollapsing|^Aggregating|^Summing/.test(t.engine)
      ? ' FINAL'
      : '';
    facts.tables[t.name] = Number(
      chq(ctr, `SELECT count() FROM ${CH_DB}.\`${t.name}\`${final}`).trim(),
    );
  }
  for (const v of order.views)
    facts.views[v] = Number(chq(ctr, `SELECT count() FROM ${CH_DB}.\`${v}\``).trim());
  if (order.data.includes('raw_events')) {
    for (const [topic, n] of tsv(
      chq(
        ctr,
        `SELECT topic, uniqExact(event_id) FROM ${CH_DB}.raw_events GROUP BY topic ORDER BY topic FORMAT TSV`,
      ),
    ))
      facts.topics[topic] = Number(n);
    const newest = chq(
      ctr,
      `SELECT if(count() = 0, '', toString(max(ingested_at))) FROM ${CH_DB}.raw_events FORMAT TSVRaw`,
    ).trim();
    facts.newestIngestedAt = newest ? `${newest.replace(' ', 'T')}Z` : null;
  }
  return facts;
}

async function backupClickhouse(dir) {
  const ctr = container(SHARED_PROJECT, 'clickhouse');
  const out = join(dir, 'clickhouse');
  mkdirSync(out, { recursive: true });
  // ClickHouse has no snapshot to hold: take the numbers before and after the export and retry if they moved.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = chFacts(ctr);
    docker(['exec', ctr, 'sh', '-c', 'rm -rf /tmp/dr-ch && mkdir -p /tmp/dr-ch']);
    const tables = chTables(ctr);
    const order = chOrder(tables);
    for (const t of tables) {
      writeFileSync(
        join(out, `${t.name}.sql`),
        chq(ctr, `SHOW CREATE TABLE ${CH_DB}.\`${t.name}\` FORMAT TSVRaw`),
      );
      if (order.data.includes(t.name))
        chq(
          ctr,
          `SELECT * FROM ${CH_DB}.\`${t.name}\` INTO OUTFILE '/tmp/dr-ch/${t.name}.native' FORMAT Native`,
        );
    }
    const after = chFacts(ctr);
    const moved = diff(before, after);
    if (!moved.length) {
      docker(['cp', `${ctr}:/tmp/dr-ch/.`, hostPath(out)]);
      docker(['exec', ctr, 'rm', '-rf', '/tmp/dr-ch'], { allowFail: true });
      writeFileSync(join(out, 'tables.json'), JSON.stringify(tables, null, 2));
      step(
        `clickhouse: ${order.data.length} tables (+${order.views.length} views, ${order.mvs.length} MVs) exported`,
      );
      return { database: CH_DB, ...after };
    }
    step(`clickhouse: the data moved during export (${moved[0]}); attempt ${attempt} again`);
  }
  docker(['exec', ctr, 'rm', '-rf', '/tmp/dr-ch'], { allowFail: true });
  throw new Error('clickhouse: the data kept moving during three exports');
}

function restoreClickhouse(dir) {
  const ctr = container(DRILL_PROJECT, 'clickhouse');
  const src = join(dir, 'clickhouse');
  const tables = JSON.parse(readFileSync(join(src, 'tables.json'), 'utf8'));
  const order = chOrder(tables);
  docker(['exec', ctr, 'mkdir', '-p', '/tmp/dr-ch']);
  docker(['cp', `${hostPath(src)}/.`, `${ctr}:/tmp/dr-ch`]);
  const ddl = (n) => readFileSync(join(src, `${n}.sql`), 'utf8');
  for (const t of order.data) {
    chq(ctr, ddl(t));
    if (existsSync(join(src, `${t}.native`)))
      chq(ctr, `INSERT INTO ${CH_DB}.\`${t}\` FROM INFILE '/tmp/dr-ch/${t}.native' FORMAT Native`);
  }
  // Views may read other views: create what can be created, until nothing is left (or nothing moves).
  let pending = [...order.views];
  while (pending.length) {
    const failed = [];
    let lastError;
    for (const v of pending) {
      try {
        chq(ctr, ddl(v));
      } catch (e) {
        failed.push(v);
        lastError = e;
      }
    }
    if (failed.length === pending.length)
      throw new Error(
        `clickhouse: views ${failed.join(', ')} would not create: ${lastError.message}`,
      );
    pending = failed;
  }
  for (const mv of order.mvs) chq(ctr, ddl(mv));
}

/** The access users come from data/clickhouse/access, as everywhere: ch:migrate against the DRILL server. */
function clickhouseAccess() {
  const passwords = {
    CLICKHOUSE_INGEST_PASSWORD: randomBytes(18).toString('base64url'),
    CLICKHOUSE_READONLY_PASSWORD: randomBytes(18).toString('base64url'),
  };
  const env = {
    CLICKHOUSE_URL: DRILL.ch,
    CLICKHOUSE_DATABASE: CH_DB,
    CLICKHOUSE_USER: 'platform',
    CLICKHOUSE_PASSWORD: 'platform',
    CLICKHOUSE_INGEST_USER: 'analytics_ingest',
    CLICKHOUSE_READONLY_USER: 'analytics_ro',
    ...passwords,
  };
  // ch:migrate's fallback URL is the SHARED server: never spawn it without the drill's.
  if (!env.CLICKHOUSE_URL.endsWith(`:${DRILL_PORTS.clickhouse}`))
    throw new Error('refusing ch:migrate: not the drill ClickHouse');
  const r = run('pnpm', ['--filter', '@platform/analytics-ingest', 'ch:migrate'], {
    env,
    shell: true,
  });
  const events = r.stdout
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));
  return {
    migrated: events.find((e) => e.event === 'migrated') ?? null,
    readonlyPassword: passwords.CLICKHOUSE_READONLY_PASSWORD,
  };
}

// ---- Keycloak --------------------------------------------------------------------------------------------------

async function backupKeycloak(dir) {
  const out = join(dir, 'keycloak');
  mkdirSync(out, { recursive: true });
  const shared = loopback(ENV.KEYCLOAK_URL ?? 'http://127.0.0.1:8180');
  // The same partial export as `reimport.mjs --export`, called here: that script's DEFAULT action deletes and
  // re-creates the realm, so the drill never spawns it against the shared Keycloak.
  const auth = await kcAdminToken(shared);
  const facts = {};
  for (const realm of REALMS) {
    const exported = await http(
      'POST',
      `${shared}/admin/realms/${realm}/partial-export?exportClients=true&exportGroupsAndRoles=true`,
      null,
      auth,
    );
    // K2: the partial export has no users; the realm file's are the dev users (production backs up the Keycloak DB).
    const users =
      JSON.parse(readFileSync(join(ROOT, `infra/keycloak/${realm}-realm.json`), 'utf8')).users ??
      [];
    writeFileSync(
      join(out, `${realm}-realm.json`),
      JSON.stringify({ ...exported, users }, null, 2),
    );
    facts[realm] = {
      // /users/count leaves service-account users out
      users: users.filter((u) => !u.serviceAccountClientId).length,
      clients: exported.clients?.length ?? 0,
      realmRoles: exported.roles?.realm?.length ?? 0,
      groups: exported.groups?.length ?? 0,
    };
  }
  step(
    `keycloak: ${REALMS.join(' + ')} exported (${REALMS.map((r) => `${facts[r].users} users, ${facts[r].clients} clients`).join('; ')})`,
  );
  return facts;
}

async function kcAdminToken(base) {
  const t = await http(
    'POST',
    `${base}/realms/master/protocol/openid-connect/token`,
    new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'admin',
      password: 'admin',
    }),
  );
  return { authorization: `Bearer ${t.access_token}` };
}

async function checkKeycloak() {
  const auth = await kcAdminToken(DRILL.kc);
  const facts = {};
  for (const realm of REALMS) {
    const base = `${DRILL.kc}/admin/realms/${realm}`;
    facts[realm] = {
      users: await http('GET', `${base}/users/count`, null, auth),
      clients: (await http('GET', `${base}/clients?max=1000`, null, auth)).length,
      realmRoles: (await http('GET', `${base}/roles?max=1000`, null, auth)).length,
      groups: (await http('GET', `${base}/groups?max=1000`, null, auth)).length,
    };
  }
  return facts;
}

/** A staff password grant on the DRILL Keycloak; returns the token's subject (never prints the token or password). */
async function staffLogin() {
  const user = JSON.parse(
    readFileSync(join(ROOT, `infra/keycloak/${LOGIN.realm}-realm.json`), 'utf8'),
  ).users.find((u) => u.username === LOGIN.username);
  const password = user?.credentials?.find((c) => c.type === 'password')?.value;
  if (!password) throw new Error(`${LOGIN.username} has no password in the realm file`);
  const t = await http(
    'POST',
    `${DRILL.kc}/realms/${LOGIN.realm}/protocol/openid-connect/token`,
    new URLSearchParams({
      grant_type: 'password',
      client_id: LOGIN.client,
      username: LOGIN.username,
      password,
      scope: 'openid',
    }),
  );
  const sub = JSON.parse(
    Buffer.from(t.access_token.split('.')[1], 'base64url').toString('utf8'),
  ).sub;
  return {
    username: LOGIN.username,
    sub,
    expectedSub: user.id,
    ok: Boolean(sub) && sub === user.id,
  };
}

// ---- OpenFGA ---------------------------------------------------------------------------------------------------

async function fgaTuples(base, store) {
  const keys = [];
  let token = '';
  do {
    const page = await http('POST', `${base}/stores/${store}/read`, {
      page_size: 100,
      ...(token ? { continuation_token: token } : {}),
    });
    keys.push(...page.tuples.map((t) => t.key));
    token = page.continuation_token;
  } while (token);
  return keys;
}

async function backupOpenfga(dir) {
  const base = loopback(ENV.OPENFGA_API_URL ?? 'http://127.0.0.1:8081');
  const store = ENV.OPENFGA_STORE_ID;
  if (!store)
    throw new Error(
      'OPENFGA_STORE_ID is not set: run `pnpm --filter @platform/auth-sdk fga:seed` first (after a Docker restart the store is gone)',
    );
  const model = ENV.OPENFGA_MODEL_ID
    ? (await http('GET', `${base}/stores/${store}/authorization-models/${ENV.OPENFGA_MODEL_ID}`))
        .authorization_model
    : (await http('GET', `${base}/stores/${store}/authorization-models?page_size=1`))
        .authorization_models[0];
  const keys = await fgaTuples(base, store);
  mkdirSync(join(dir, 'openfga'), { recursive: true });
  writeFileSync(join(dir, 'openfga/model.json'), JSON.stringify(model, null, 2));
  writeFileSync(join(dir, 'openfga/tuples.json'), JSON.stringify(keys, null, 2));
  step(`openfga: model ${model.id} + ${keys.length} tuples exported`);
  return { modelTypes: model.type_definitions.length, tuples: tuplesDigest(keys) };
}

async function restoreOpenfga(dir) {
  const model = JSON.parse(readFileSync(join(dir, 'openfga/model.json'), 'utf8'));
  const keys = JSON.parse(readFileSync(join(dir, 'openfga/tuples.json'), 'utf8'));
  const store = (await http('POST', `${DRILL.fga}/stores`, { name: 'dr-drill' })).id;
  const modelId = (
    await http('POST', `${DRILL.fga}/stores/${store}/authorization-models`, {
      schema_version: model.schema_version,
      type_definitions: model.type_definitions,
      ...(model.conditions ? { conditions: model.conditions } : {}),
    })
  ).authorization_model_id;
  for (let i = 0; i < keys.length; i += 100)
    await http('POST', `${DRILL.fga}/stores/${store}/write`, {
      writes: { tuple_keys: keys.slice(i, i + 100) },
      authorization_model_id: modelId,
    });
  return { store, modelId };
}

/** One allowed and one denied check on the restored store, for the subject the staff login returned. */
//
// The path the core takes: the token's sub → staff_user.keycloak_subject → staff_user.id, which is the OpenFGA
// `user:<id>` (packages/auth-sdk). So this joins the restored Keycloak, Postgres and OpenFGA: allowed on one of that
// user's own tuples, and denied for the SAME user and relation on another object of that type (a store it does not
// administer), not for an anonymous nobody. Endpoints are parameters so it can be dry-run against any stack.
export async function permissionCheck({ fgaBase, store, modelId, pgUrl }, sub) {
  const client = new (pgModule().Client)({ connectionString: pgUrl });
  await client.connect();
  let staffId;
  try {
    staffId = (
      await client.query(
        'SELECT id::text AS id FROM public.staff_user WHERE keycloak_subject = $1',
        [sub],
      )
    ).rows[0]?.id;
  } finally {
    await client.end().catch(() => {});
  }
  if (!staffId)
    throw new Error(`openfga: no staff_user with keycloak_subject ${sub} in the restored Postgres`);
  const user = `user:${staffId}`;
  const keys = await fgaTuples(fgaBase, store);
  const own = keys.filter((k) => !k.condition && k.user === user);
  if (!own.length) throw new Error(`openfga: the logged-in user (${user}) has no tuple to check`);
  const pick = own[0];
  const check = async (relation, object) =>
    (
      await http('POST', `${fgaBase}/stores/${store}/check`, {
        tuple_key: { user, relation, object },
        authorization_model_id: modelId,
      })
    ).allowed;
  const allowed = await check(pick.relation, pick.object);
  const type = pick.object.split(':')[0];
  const candidates = [...new Set(keys.flatMap((k) => [k.object, k.user]))].filter(
    (o) =>
      o.startsWith(`${type}:`) && !own.some((k) => k.relation === pick.relation && k.object === o),
  );
  let deniedOn = null;
  for (const o of candidates) {
    if (!(await check(pick.relation, o))) {
      deniedOn = o;
      break;
    }
  }
  return {
    staffUserId: staffId,
    allowedOn: `${user} ${pick.relation} ${pick.object}`,
    deniedOn: deniedOn ? `${user} ${pick.relation} ${deniedOn}` : null,
    allowed,
    ok: allowed === true && deniedOn !== null,
    restored: tuplesDigest(keys),
  };
}

// ---- the drill stack -------------------------------------------------------------------------------------------

const compose = (args, importDir = join(ROOT, 'infra/dr')) =>
  docker(['compose', '-p', DRILL_PROJECT, '-f', DRILL_COMPOSE, ...args], {
    env: { DR_KEYCLOAK_IMPORT: hostPath(importDir) },
  });

const portFree = (port) =>
  new Promise((ok) => {
    const s = createServer()
      .once('error', () => ok(false))
      .once('listening', () => s.close(() => ok(true)));
    s.listen(port, '0.0.0.0');
  });

/** Refuse to start when the drill could collide with the shared stack or with a drill already up. */
async function guard() {
  if (DRILL_PROJECT === SHARED_PROJECT)
    throw new Error('the drill project name must differ from the shared one');
  const left = docker([
    'ps',
    '-a',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${DRILL_PROJECT}`,
  ]).stdout.trim();
  if (left)
    throw new Error(
      `a ${DRILL_PROJECT} stack already exists: run \`node infra/dr/drill.mjs teardown\` first`,
    );
  const used = new Set(dockerHostPorts(docker(['ps', '--format', '{{.Ports}}']).stdout));
  for (const [service, port] of Object.entries(DRILL_PORTS)) {
    if (used.has(port))
      throw new Error(`port ${port} (drill ${service}) is published by a running container`);
    if (!(await portFree(port)))
      throw new Error(`port ${port} (drill ${service}) is in use on this machine`);
  }
}

export function teardown() {
  step(`teardown: docker compose -p ${DRILL_PROJECT} down -v`);
  compose(['down', '-v', '--remove-orphans']);
}

// ---- the drill -------------------------------------------------------------------------------------------------

function backupRoot() {
  return resolve(ENV.DR_BACKUP_DIR ?? 'C:/Users/mehdi/Desktop/commerce-platform-backups');
}

async function backup() {
  const startedAt = new Date().toISOString();
  const dir = join(backupRoot(), `dr-${startedAt.replace(/[-:]/g, '').replace(/\..*/, 'Z')}`);
  mkdirSync(dir, { recursive: true });
  step(`backup → ${dir}`);
  const t0 = Date.now();
  const manifest = {
    version: 1,
    startedAt,
    postgres: await backupPostgres(dir),
    clickhouse: await backupClickhouse(dir),
  };
  manifest.keycloak = await backupKeycloak(dir);
  manifest.openfga = await backupOpenfga(dir);
  manifest.finishedAt = new Date().toISOString();
  manifest.backupSeconds = Math.round((Date.now() - t0) / 1000);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  step(`backup done in ${manifest.backupSeconds} s`);
  return dir;
}

function latestBackup() {
  const root = backupRoot();
  const dirs = existsSync(root)
    ? readdirSync(root)
        .filter((d) => /^dr-\d{8}T\d{6}Z$/.test(d))
        .sort()
    : [];
  if (!dirs.length) throw new Error(`no dr-* backup under ${root}`);
  return join(root, dirs.at(-1));
}

async function restoreAndCheck(dir, { keep = false } = {}) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  await guard();
  const report = {
    backup: dir,
    backupStartedAt: manifest.startedAt,
    restoredAt: new Date().toISOString(),
  };
  const t0 = Date.now();
  try {
    step('drill stack: compose up --wait (fresh volumes)');
    compose(['up', '-d', '--wait'], join(dir, 'keycloak'));
    const tUp = Date.now();
    step('restore: postgres');
    await restorePostgres(dir);
    step('restore: clickhouse');
    restoreClickhouse(dir);
    const access = clickhouseAccess();
    step('restore: openfga');
    const fga = await restoreOpenfga(dir);
    const tRestored = Date.now();

    step('check: postgres, clickhouse, keycloak, openfga, login, permission');
    const pgActual = await checkPostgres();
    const chCtr = container(DRILL_PROJECT, 'clickhouse');
    const chActual = chFacts(chCtr);
    const roCount = Number(
      chq(
        chCtr,
        `SELECT count() FROM ${CH_DB}.raw_events FINAL`,
        'analytics_ro',
        access.readonlyPassword,
      ).trim(),
    );
    const kcActual = await checkKeycloak();
    const login = await staffLogin();
    const permission = await permissionCheck(
      { fgaBase: DRILL.fga, ...fga, pgUrl: DRILL.pg },
      login.sub,
    );
    // the manifest's descriptive fields are not facts a restore reproduces
    const { dumpBytes: _bytes, database: _pgDb, ...pgExpected } = manifest.postgres;
    const { database: _chDb, ...chExpected } = manifest.clickhouse;
    const failures = [
      ...diff(pgExpected, pgActual).map((d) => `postgres.${d}`),
      ...diff(chExpected, chActual).map((d) => `clickhouse.${d}`),
      ...diff(manifest.keycloak, kcActual).map((d) => `keycloak.${d}`),
      ...diff(manifest.openfga.tuples, permission.restored).map((d) => `openfga.tuples.${d}`),
      ...(roCount === (chExpected.tables.raw_events ?? 0)
        ? []
        : [`clickhouse: analytics_ro reads ${roCount} raw_events`]),
      ...(login.ok
        ? []
        : [`keycloak: ${LOGIN.username} logged in as ${login.sub}, expected ${login.expectedSub}`]),
      ...(permission.ok
        ? []
        : [
            `openfga: allowed=${permission.allowed} on ${permission.allowedOn}; denied on ${permission.deniedOn ?? 'no object of that type'}`,
          ]),
    ];
    const tGreen = Date.now();
    Object.assign(report, {
      ok: failures.length === 0,
      failures,
      rtoSeconds: Math.round((tGreen - t0) / 1000),
      stackUpSeconds: Math.round((tUp - t0) / 1000),
      dataRestoreSeconds: Math.round((tRestored - tUp) / 1000),
      checkSeconds: Math.round((tGreen - tRestored) / 1000),
      rpoSeconds: rpoSeconds(manifest.startedAt, [pgActual.newestRowAt, chActual.newestIngestedAt]),
      newestRestored: { postgres: pgActual.newestRowAt, clickhouse: chActual.newestIngestedAt },
      counted: {
        postgresTables: Object.keys(pgActual.tables).length,
        postgresRows: Object.values(pgActual.tables).reduce((a, b) => a + b, 0),
        tenantColumns: Object.keys(pgActual.perTenant).length,
        clickhouseTables: Object.keys(chActual.tables).length,
        clickhouseViews: Object.keys(chActual.views).length,
        topics: chActual.topics,
        fgaTuples: permission.restored.count,
      },
      chMigrate: access.migrated,
      login: { username: login.username, sub: login.sub, ok: login.ok },
      permission: {
        staffUserId: permission.staffUserId,
        allowedOn: permission.allowedOn,
        deniedOn: permission.deniedOn,
        ok: permission.ok,
      },
    });
  } catch (error) {
    Object.assign(report, { ok: false, failures: [`aborted: ${error.message}`], rtoSeconds: null });
  } finally {
    if (keep)
      step(`--keep: the drill stack stays up; \`node infra/dr/drill.mjs teardown\` removes it`);
    else teardown();
  }
  writeFileSync(
    join(dir, `report-${report.restoredAt.replace(/[-:]/g, '').replace(/\..*/, 'Z')}.json`),
    JSON.stringify(report, null, 2),
  );
  return report;
}

function printReport(r) {
  step(r.ok ? 'CHECKS GREEN' : `CHECKS FAILED (${r.failures.length})`);
  for (const f of r.failures.slice(0, 40)) console.info(`  FAIL ${f}`);
  if (r.rtoSeconds != null)
    console.info(
      `  RTO ${r.rtoSeconds} s (stack up ${r.stackUpSeconds} s, data ${r.dataRestoreSeconds} s, checks ${r.checkSeconds} s) · RPO ${r.rpoSeconds} s`,
    );
  if (r.counted) console.info(`  ${JSON.stringify(r.counted)}`);
}

async function main(argv) {
  const [cmd, maybeDir] = argv.filter((a) => !a.startsWith('--'));
  const keep = argv.includes('--keep');
  if (cmd === 'backup') return void console.info(await backup());
  if (cmd === 'teardown') return void teardown();
  if (cmd === 'restore' || cmd === 'all') {
    const dir = cmd === 'all' ? await backup() : maybeDir ? resolve(maybeDir) : latestBackup();
    const report = await restoreAndCheck(dir, { keep });
    printReport(report);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  console.error(
    'usage: node infra/dr/drill.mjs all | backup | restore [<dir>] | teardown   [--keep]',
  );
  process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`drill: ${error.message}`);
    process.exitCode = 1;
  });
}
