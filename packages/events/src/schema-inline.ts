// Inlines every `$ref` to common/v1.json#/$defs/<name> with the definition itself (issue #532).
// The registry's JSON compatibility checker (Redpanda 24.2) rejects `$ref`; our own BACKWARD checker and the
// registered copy therefore work on self-contained schemas. The generator (scripts/generate.mjs) does the same for
// the TypeScript types. Canonical form (sorted keys, no whitespace) + sha256 identify a published schema.
import { createHash } from 'node:crypto';
import { COMMON_SCHEMA } from './generated/schemas.js';

const COMMON_REF = /common\/v1\.json#\/\$defs\/(\w+)$/;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** The schema with common $refs replaced by their definitions; everything else untouched. Throws on an unknown $ref. */
export function inlineCommonRefs(
  node: unknown,
  defs: Record<string, unknown> = commonDefs(),
): unknown {
  if (Array.isArray(node)) return node.map((n) => inlineCommonRefs(n, defs));
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (typeof o.$ref === 'string') {
      const m = COMMON_REF.exec(o.$ref);
      if (!m)
        throw new Error(
          `unsupported $ref ${o.$ref} (only common/v1.json#/$defs/<name> is inlined)`,
        );
      const def = defs[m[1]!];
      if (!def) throw new Error(`unknown common definition ${m[1]} in ${o.$ref}`);
      return inlineCommonRefs(def, defs);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = inlineCommonRefs(v, defs);
    return out;
  }
  return node;
}

function commonDefs(): Record<string, unknown> {
  return (COMMON_SCHEMA as unknown as { $defs: Record<string, unknown> }).$defs;
}

function sortKeys(node: unknown): Json {
  if (Array.isArray(node)) return node.map(sortKeys);
  if (node && typeof node === 'object') {
    const out: { [k: string]: Json } = {};
    for (const k of Object.keys(node as object).sort()) {
      out[k] = sortKeys((node as Record<string, unknown>)[k]);
    }
    return out;
  }
  return node as Json;
}

/** Deterministic JSON: sorted keys, no whitespace. Two schemas are the same published schema iff this is equal. */
export function canonicalJson(schema: unknown): string {
  return JSON.stringify(sortKeys(schema));
}

export function schemaDigest(schema: unknown): string {
  return createHash('sha256').update(canonicalJson(schema)).digest('hex');
}
