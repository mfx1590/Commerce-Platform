// Loads the frozen authorization model (infra/openfga/model.fga) and the seed tuples (tuples.seed.json).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TupleKey, WriteAuthorizationModelRequest } from '@openfga/sdk';
import { transformer } from '@openfga/syntax-transformer';

/** Directory holding model.fga and tuples.seed.json (owned by window 2). */
export const OPENFGA_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../infra/openfga',
);

export function readModelDsl(dir: string = OPENFGA_DIR): string {
  return readFileSync(resolve(dir, 'model.fga'), 'utf8');
}

/** DSL → the JSON body OpenFGA's WriteAuthorizationModel expects. */
export function modelFromDsl(dsl: string): WriteAuthorizationModelRequest {
  const json = transformer.transformDSLToJSONObject(dsl);
  return {
    schema_version: json.schema_version,
    type_definitions: json.type_definitions,
    ...(json.conditions ? { conditions: json.conditions } : {}),
  };
}

export function loadAuthorizationModel(dir: string = OPENFGA_DIR): WriteAuthorizationModelRequest {
  return modelFromDsl(readModelDsl(dir));
}

export function loadSeedTuples(dir: string = OPENFGA_DIR): TupleKey[] {
  const raw = JSON.parse(readFileSync(resolve(dir, 'tuples.seed.json'), 'utf8')) as {
    tuples: TupleKey[];
  };
  return raw.tuples.map((t) => ({ user: t.user, relation: t.relation, object: t.object }));
}
