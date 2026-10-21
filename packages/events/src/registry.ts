// Schema registry client (issue #532): Confluent-compatible REST API (Redpanda's on 18081), plain fetch, no
// dependency. Subjects are one per (topic, version) — `<topic>-v<N>-value` — with BACKWARD compatibility on each:
// a published version may only evolve compatibly; a new version is a new file, a new subject, free to break
// (ADR 0003). The registered schema is the file with the common $defs inlined (the registry's JSON checker
// rejects $ref). See infra/redpanda/README.md.
import { EVENT_SCHEMAS } from './generated/schemas.js';
import { canonicalJson, inlineCommonRefs } from './schema-inline.js';

export const DEFAULT_REGISTRY_URL = 'http://127.0.0.1:18081';

export function registryUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.SCHEMA_REGISTRY_URL?.trim() || DEFAULT_REGISTRY_URL;
}

export function subjectFor(topic: string, version: number, prefix = ''): string {
  return `${prefix}${topic}-v${version}-value`;
}

export class RegistryError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(`schema registry ${path} → ${status}: ${message}`);
    this.name = 'RegistryError';
  }
}

export type CompatibilityLevel =
  | 'BACKWARD'
  | 'BACKWARD_TRANSITIVE'
  | 'FORWARD'
  | 'FORWARD_TRANSITIVE'
  | 'FULL'
  | 'FULL_TRANSITIVE'
  | 'NONE';

export interface RegistryClient {
  readonly url: string;
  /** Registers (idempotent: the same schema under the same subject answers the existing id). */
  register(subject: string, schema: unknown): Promise<{ id: number }>;
  /** The id and version of this exact schema under the subject, or null when it is not registered. */
  lookup(subject: string, schema: unknown): Promise<{ id: number; version: number } | null>;
  checkCompatibility(
    subject: string,
    schema: unknown,
  ): Promise<{ compatible: boolean; messages: string[] }>;
  getCompatibility(subject: string): Promise<CompatibilityLevel | null>;
  setCompatibility(subject: string, level: CompatibilityLevel): Promise<void>;
  listSubjects(): Promise<string[]>;
  getById(id: number): Promise<unknown>;
  /** Soft delete, then permanent when asked (tests clean their own prefixed subjects). */
  deleteSubject(subject: string, permanent?: boolean): Promise<void>;
  reachable(): Promise<boolean>;
}

const CONTENT_TYPE = 'application/vnd.schemaregistry.v1+json';

export function createRegistryClient(
  opts: { url?: string; fetch?: typeof fetch } = {},
): RegistryClient {
  const url = (opts.url ?? registryUrlFromEnv()).replace(/\/$/, '');
  const f = opts.fetch ?? fetch;

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    okStatuses: number[] = [200],
  ): Promise<{ status: number; data: T }> {
    const res = await f(`${url}${path}`, {
      method,
      headers: { 'content-type': CONTENT_TYPE, accept: CONTENT_TYPE },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body: kept as text */
    }
    if (!okStatuses.includes(res.status)) {
      const msg = (data as { message?: string } | null)?.message ?? text.slice(0, 200);
      throw new RegistryError(res.status, `${method} ${path}`, msg);
    }
    return { status: res.status, data: data as T };
  }
  const body = (schema: unknown) => ({ schemaType: 'JSON', schema: canonicalJson(schema) });
  const s = (subject: string) => encodeURIComponent(subject);

  return {
    url,
    async register(subject, schema) {
      return (await call<{ id: number }>('POST', `/subjects/${s(subject)}/versions`, body(schema)))
        .data;
    },
    async lookup(subject, schema) {
      const r = await call<{ id: number; version: number }>(
        'POST',
        `/subjects/${s(subject)}`,
        body(schema),
        [200, 404],
      );
      return r.status === 404 ? null : { id: r.data.id, version: r.data.version };
    },
    async checkCompatibility(subject, schema) {
      const r = await call<{ is_compatible: boolean; messages?: string[] }>(
        'POST',
        `/compatibility/subjects/${s(subject)}/versions/latest?verbose=true`,
        body(schema),
      );
      return { compatible: r.data.is_compatible === true, messages: r.data.messages ?? [] };
    },
    async getCompatibility(subject) {
      const r = await call<{ compatibilityLevel?: CompatibilityLevel }>(
        'GET',
        `/config/${s(subject)}`,
        undefined,
        [200, 404],
      );
      return r.status === 404 ? null : (r.data.compatibilityLevel ?? null);
    },
    async setCompatibility(subject, level) {
      await call('PUT', `/config/${s(subject)}`, { compatibility: level });
    },
    async listSubjects() {
      return (await call<string[]>('GET', '/subjects')).data;
    },
    async getById(id) {
      const r = await call<{ schema: string }>('GET', `/schemas/ids/${id}`);
      return JSON.parse(r.data.schema) as unknown;
    },
    async deleteSubject(subject, permanent = false) {
      await call('DELETE', `/subjects/${s(subject)}`, undefined, [200, 404]);
      if (permanent)
        await call('DELETE', `/subjects/${s(subject)}?permanent=true`, undefined, [200, 404]);
    },
    async reachable() {
      try {
        await call('GET', '/subjects');
        return true;
      } catch {
        return false;
      }
    },
  };
}

export interface RegisteredSchema {
  topic: string;
  version: number;
  subject: string;
  /** The inlined, self-contained schema that goes to the registry. */
  schema: unknown;
}

/** Every event schema of this package as the registry sees it (inlined), sorted by topic then version. */
export function registrySchemas(prefix = ''): RegisteredSchema[] {
  return Object.entries(EVENT_SCHEMAS)
    .map(([key, schema]) => {
      const [topic, v] = key.split('@') as [string, string];
      const version = Number(v);
      return {
        topic,
        version,
        subject: subjectFor(topic, version, prefix),
        schema: inlineCommonRefs(schema),
      };
    })
    .sort((a, b) => a.topic.localeCompare(b.topic) || a.version - b.version);
}

export const schemaKey = (topic: string, version: number): string => `${topic}@${version}`;

export interface RegisterAllResult {
  /** `topic@version` → registry id. */
  ids: Record<string, number>;
  registered: string[];
  unchanged: string[];
  compatibility_set: string[];
  /** Subjects whose latest registered schema differs from the file AND would not accept it under BACKWARD. */
  refused: { subject: string; messages: string[] }[];
}

/**
 * Registers every schema idempotently (a second run registers nothing), sets BACKWARD on every subject that does
 * not have it, and returns the id map the relay stamps on messages. With `dryRun` nothing is written.
 */
export async function registerAllSchemas(
  client: RegistryClient,
  opts: { prefix?: string; dryRun?: boolean } = {},
): Promise<RegisterAllResult> {
  const result: RegisterAllResult = {
    ids: {},
    registered: [],
    unchanged: [],
    compatibility_set: [],
    refused: [],
  };
  for (const entry of registrySchemas(opts.prefix)) {
    const key = schemaKey(entry.topic, entry.version);
    const found = await client.lookup(entry.subject, entry.schema);
    if (found) {
      result.ids[key] = found.id;
      result.unchanged.push(entry.subject);
    } else if (opts.dryRun) {
      result.registered.push(entry.subject);
    } else {
      try {
        const { id } = await client.register(entry.subject, entry.schema);
        result.ids[key] = id;
        result.registered.push(entry.subject);
      } catch (err) {
        if (err instanceof RegistryError && (err.status === 409 || err.status === 422)) {
          result.refused.push({ subject: entry.subject, messages: [err.message] });
          continue;
        }
        throw err;
      }
    }
    if ((await client.getCompatibility(entry.subject)) !== 'BACKWARD') {
      if (!opts.dryRun) await client.setCompatibility(entry.subject, 'BACKWARD');
      result.compatibility_set.push(entry.subject);
    }
  }
  return result;
}

/** `topic@version` → id for every schema, by lookup only; throws naming the schemas the registry does not have. */
export async function resolveSchemaIds(
  client: RegistryClient,
  prefix = '',
): Promise<Record<string, number>> {
  const ids: Record<string, number> = {};
  const missing: string[] = [];
  for (const entry of registrySchemas(prefix)) {
    const found = await client.lookup(entry.subject, entry.schema);
    if (found) ids[schemaKey(entry.topic, entry.version)] = found.id;
    else missing.push(entry.subject);
  }
  if (missing.length > 0) {
    throw new Error(
      `schema registry at ${client.url} lacks ${missing.length} schema(s): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''} — run infra/redpanda/register-schemas.mjs`,
    );
  }
  return ids;
}
