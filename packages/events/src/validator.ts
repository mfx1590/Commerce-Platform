// The Ajv validator (envelope + payload per topic@version). Its own module so the SDK files (dlq.ts) can validate
// without importing the package index (#629: replayFromDlq validates a scrubbed envelope).
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { COMMON_SCHEMA, ENVELOPE_SCHEMA, EVENT_SCHEMAS } from './generated/schemas.js';
import type { EventEnvelopeV1Base } from './generated/types.js';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
}

/**
 * Compiles every schema once. Use one instance per process.
 * `validateEnvelope` checks the envelope AND the payload against `schemas/<topic>/v<version>.json`.
 */
export function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  // ajv-formats ships a CJS default export; under NodeNext ESM it may arrive wrapped.
  const applyFormats = ((addFormats as unknown as { default?: unknown }).default ?? addFormats) as (
    a: Ajv2020,
  ) => void;
  applyFormats(ajv);
  ajv.addSchema(COMMON_SCHEMA as unknown as object);
  const envelopeFn = ajv.compile(ENVELOPE_SCHEMA as unknown as object);
  const payloadFns = new Map<string, ValidateFunction>();
  for (const [key, schema] of Object.entries(EVENT_SCHEMAS)) {
    payloadFns.set(key, ajv.compile(schema as unknown as object));
  }

  const validatePayload = (topic: string, version: number, payload: unknown): ValidationResult => {
    const fn = payloadFns.get(`${topic}@${version}`);
    if (!fn) return { ok: false, errors: [`unknown event ${topic}@${version}`] };
    const ok = fn(payload);
    return { ok: ok === true, errors: ok ? [] : formatErrors(fn.errors) };
  };

  const validateEnvelope = (event: unknown): ValidationResult => {
    const ok = envelopeFn(event);
    if (!ok) return { ok: false, errors: formatErrors(envelopeFn.errors) };
    const e = event as EventEnvelopeV1Base;
    const p = validatePayload(e.topic, e.version, e.payload);
    return p.ok ? p : { ok: false, errors: p.errors.map((m) => `/payload${m}`) };
  };

  return { validateEnvelope, validatePayload, ajv };
}

export type Validator = ReturnType<typeof createValidator>;
