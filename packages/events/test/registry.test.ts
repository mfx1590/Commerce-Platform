// The schema registry (#532): client behaviour against a fake, and the live block against the local Redpanda
// registry on t-<rand> subjects (self-cleaning; skipped with a printed reason when the registry is down).
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  backwardIncompatibilities,
  createRegistryClient,
  EVENT_SCHEMAS,
  inlineCommonRefs,
  registerAllSchemas,
  RegistryError,
  registrySchemas,
  registryUrlFromEnv,
  resolveSchemaIds,
  subjectFor,
} from '../src/index.js';

describe('register-schemas.mjs arguments', () => {
  it('--url without a value is refused (exit 2) before anything is loaded', () => {
    const script = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../infra/redpanda/register-schemas.mjs',
    );
    const r = spawnSync(process.execPath, [script, '--url'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--url needs a value/);
    const r2 = spawnSync(process.execPath, [script, '--url', '--dry-run'], { encoding: 'utf8' });
    expect(r2.status).toBe(2);
  });
});

describe('registry client (fake transport)', () => {
  it('registryUrlFromEnv defaults to the local compose registry', () => {
    expect(registryUrlFromEnv({})).toBe('http://127.0.0.1:18081');
    expect(registryUrlFromEnv({ SCHEMA_REGISTRY_URL: ' http://r:1/ ' })).toBe('http://r:1/');
  });

  it('registerAllSchemas: lookup first, register only what is missing, set BACKWARD only where unset; dry run writes nothing', async () => {
    const calls: string[] = [];
    const known = new Map<string, number>([[subjectFor('order.placed', 1), 7]]);
    const levels = new Map<string, string>([[subjectFor('order.placed', 1), 'BACKWARD']]);
    let nextId = 100;
    const fake: typeof fetch = async (input, init) => {
      const path = String(input).replace('http://fake', '');
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${path}`);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status });
      const m = /^\/subjects\/([^/]+)(\/versions)?$/.exec(path);
      if (m && method === 'POST' && !m[2]) {
        const s = decodeURIComponent(m[1]!);
        return known.has(s)
          ? json(200, { subject: s, id: known.get(s), version: 1 })
          : json(404, { error_code: 40401, message: 'not found' });
      }
      if (m && method === 'POST' && m[2]) {
        const s = decodeURIComponent(m[1]!);
        if (s === 'customer.erased-v1-value')
          return json(409, { error_code: 409, message: 'incompatible' });
        const id = nextId++;
        known.set(s, id);
        return json(200, { id });
      }
      if (path.startsWith('/config/')) {
        const subject = decodeURIComponent(path.slice('/config/'.length));
        if (method === 'GET') {
          return levels.has(subject)
            ? json(200, { compatibilityLevel: levels.get(subject) })
            : json(404, { message: 'unset' });
        }
        if (method === 'PUT') {
          levels.set(subject, 'BACKWARD');
          return json(200, { compatibility: 'BACKWARD' });
        }
      }
      if (path === '/subjects') return json(200, [...known.keys()]);
      return json(500, { message: `unexpected ${method} ${path}` });
    };
    const client = createRegistryClient({ url: 'http://fake/', fetch: fake });
    expect(client.url).toBe('http://fake');

    const dry = await registerAllSchemas(client, { dryRun: true });
    expect(dry.unchanged).toEqual(['order.placed-v1-value']);
    expect(dry.registered).toHaveLength(Object.keys(EVENT_SCHEMAS).length - 1);
    expect(calls.some((c) => c.startsWith('POST /subjects/') && c.endsWith('/versions'))).toBe(
      false,
    );
    expect(calls.some((c) => c.startsWith('PUT /config/'))).toBe(false);

    calls.length = 0;
    const r = await registerAllSchemas(client);
    expect(r.ids['order.placed@1']).toBe(7);
    expect(r.unchanged).toEqual(['order.placed-v1-value']);
    expect(r.refused).toEqual([
      {
        subject: 'customer.erased-v1-value',
        messages: [expect.stringMatching(/409: incompatible/)],
      },
    ]);
    expect(r.registered).toHaveLength(Object.keys(EVENT_SCHEMAS).length - 2);
    expect(r.compatibility_set).not.toContain('order.placed-v1-value');
    expect(r.compatibility_set).toContain('store.created-v1-value');
    expect(calls.filter((c) => c.startsWith('PUT /config/'))).toHaveLength(
      Object.keys(EVENT_SCHEMAS).length - 2,
    ); // minus the one already BACKWARD and the refused one

    const again = await registerAllSchemas(client);
    expect(again.registered).toEqual([]);
    expect(again.compatibility_set).toEqual([]); // the refused subject is skipped before the compatibility step

    await expect(resolveSchemaIds(client)).rejects.toThrow(
      /lacks 1 schema\(s\): customer.erased-v1-value/,
    );
  });

  it('RegistryError carries the status and the registry message', async () => {
    const client = createRegistryClient({
      url: 'http://fake',
      fetch: async () =>
        new Response(JSON.stringify({ error_code: 42201, message: 'Invalid schema' }), {
          status: 422,
        }),
    });
    await expect(client.register('s', {})).rejects.toMatchObject({
      name: 'RegistryError',
      status: 422,
      message: expect.stringMatching(/POST \/subjects\/s\/versions → 422: Invalid schema/),
    });
    await expect(client.register('s', {})).rejects.toBeInstanceOf(RegistryError);
  });
});

// ---- live ---------------------------------------------------------------------------------------------------

const live = createRegistryClient();
const registryUp = await live.reachable();
if (!registryUp)
  console.warn(
    `registry.test: schema registry ${live.url} unreachable — live block skipped (pnpm compose:up)`,
  );

describe.runIf(registryUp)(
  'schema registry (live Redpanda, prefixed subjects, self-cleaning)',
  () => {
    const prefix = `t-${Math.random().toString(36).slice(2, 8)}.`;
    const mine = () => registrySchemas(prefix).map((s) => s.subject);

    afterAll(async () => {
      const existing = new Set(await live.listSubjects());
      const owned = (await live.listSubjects()).filter((s) => s.startsWith(prefix));
      for (const s of owned) await live.deleteSubject(s, true);
      console.info(`registry.test: deleted ${owned.length} test subject(s) with prefix ${prefix}`);
      expect((await live.listSubjects()).filter((s) => s.startsWith(prefix))).toEqual([]);
      expect(existing.size).toBeGreaterThanOrEqual(owned.length);
    }, 60_000);

    it('registers every schema idempotently with BACKWARD on each subject; the ids resolve and the stored schema is the inlined one', async () => {
      const first = await registerAllSchemas(live, { prefix });
      expect(first.refused).toEqual([]);
      expect(first.registered.sort()).toEqual(mine().sort());
      expect(first.compatibility_set.sort()).toEqual(mine().sort());
      expect(Object.keys(first.ids)).toHaveLength(Object.keys(EVENT_SCHEMAS).length);

      const second = await registerAllSchemas(live, { prefix });
      expect(second.registered).toEqual([]);
      expect(second.compatibility_set).toEqual([]);
      expect(second.ids).toEqual(first.ids);

      const ids = await resolveSchemaIds(live, prefix);
      expect(ids).toEqual(first.ids);
      const stored = await live.getById(ids['order.placed@1']!);
      expect(JSON.stringify(stored)).not.toContain('$ref');
      expect(stored).toEqual(
        JSON.parse(JSON.stringify(inlineCommonRefs(EVENT_SCHEMAS['order.placed@1']))),
      );
      expect(await live.getCompatibility(subjectFor('order.placed', 1, prefix))).toBe('BACKWARD');
    }, 120_000);

    it("the registry's own BACKWARD verdicts: it catches a removed property, a type change and a narrowed enum, and (Redpanda 24.2) misses an added required property — which our checker catches", async () => {
      const subject = subjectFor('store.updated', 1, prefix);
      const base = inlineCommonRefs(EVENT_SCHEMAS['store.updated@1']) as {
        required: string[];
        properties: Record<string, Record<string, unknown>>;
      };
      const edit = (fn: (s: typeof base) => void) => {
        const s = JSON.parse(JSON.stringify(base)) as typeof base;
        fn(s);
        return s;
      };
      const verdict = async (s: unknown) => (await live.checkCompatibility(subject, s)).compatible;

      expect(await verdict(base)).toBe(true);
      expect(await verdict(edit((s) => (s.properties.note = { type: 'string' })))).toBe(true);
      expect(await verdict(edit((s) => delete s.properties.code))).toBe(false);
      expect(await verdict(edit((s) => (s.properties.code = { type: 'integer' })))).toBe(false);
      expect(
        await verdict(
          edit((s) => (s.properties.status = { ...s.properties.status, enum: ['draft'] })),
        ),
      ).toBe(false);

      const addRequired = edit((s) => {
        s.properties.note = { type: 'string' };
        s.required.push('note');
      });
      // the registry's gap, pinned: when a Redpanda upgrade fixes it this line fails and the README line goes
      expect(await verdict(addRequired)).toBe(true);
      expect(backwardIncompatibilities(base, addRequired).map((i) => i.rule)).toEqual([
        'REQUIRED_ADDED',
      ]);
    }, 60_000);

    it('registering a breaking change under BACKWARD is refused by the registry (the kind it detects)', async () => {
      const subject = subjectFor('store.updated', 1, prefix);
      const base = inlineCommonRefs(EVENT_SCHEMAS['store.updated@1']) as {
        properties: Record<string, unknown>;
      };
      const broken = JSON.parse(JSON.stringify(base)) as typeof base;
      delete broken.properties.code;
      await expect(live.register(subject, broken)).rejects.toMatchObject({
        name: 'RegistryError',
        status: expect.any(Number),
      });
      expect(await live.lookup(subject, broken)).toBeNull();
    }, 60_000);
  },
);
