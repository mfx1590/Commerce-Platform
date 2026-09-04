// Idempotent OpenFGA bootstrap: store (by name) → authorization model → missing tuples.
import { OpenFgaClient, type TupleKey, type WriteAuthorizationModelRequest } from '@openfga/sdk';
import { DEFAULT_OPENFGA_API_URL } from './client.js';
import { loadAuthorizationModel, loadSeedTuples } from './model.js';

export const DEFAULT_OPENFGA_STORE_NAME = 'commerce-platform';

export interface SeedOpenFgaOptions {
  apiUrl?: string;
  /** Store to create or reuse (matched by name). */
  storeName?: string;
  /** Defaults to infra/openfga/model.fga. */
  model?: WriteAuthorizationModelRequest;
  /** Defaults to infra/openfga/tuples.seed.json. */
  tuples?: TupleKey[];
  log?: (msg: string) => void;
}

export interface SeedOpenFgaResult {
  apiUrl: string;
  storeId: string;
  storeCreated: boolean;
  modelId: string;
  tuplesWritten: number;
  tuplesSkipped: number;
  /** Client bound to the store and the model that was just written. */
  client: OpenFgaClient;
}

const tupleKey = (t: TupleKey) => `${t.user}#${t.relation}@${t.object}`;

async function readAllTuples(client: OpenFgaClient): Promise<TupleKey[]> {
  const out: TupleKey[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await client.read(
      {},
      { pageSize: 100, ...(continuationToken ? { continuationToken } : {}) },
    );
    for (const t of page.tuples) out.push(t.key);
    continuationToken = page.continuation_token || undefined;
  } while (continuationToken);
  return out;
}

export async function seedOpenFga(opts: SeedOpenFgaOptions = {}): Promise<SeedOpenFgaResult> {
  const apiUrl = opts.apiUrl ?? process.env.OPENFGA_API_URL ?? DEFAULT_OPENFGA_API_URL;
  const storeName = opts.storeName ?? DEFAULT_OPENFGA_STORE_NAME;
  const log = opts.log ?? (() => {});
  const model = opts.model ?? loadAuthorizationModel();
  const tuples = opts.tuples ?? loadSeedTuples();

  const admin = new OpenFgaClient({ apiUrl });
  const stores = await admin.listStores();
  let storeId = stores.stores.find((s) => s.name === storeName)?.id;
  let storeCreated = false;
  if (!storeId) {
    storeId = (await admin.createStore({ name: storeName })).id;
    storeCreated = true;
    log(`created store ${storeName} (${storeId})`);
  } else {
    log(`reusing store ${storeName} (${storeId})`);
  }

  const store = new OpenFgaClient({ apiUrl, storeId });
  const modelId = (await store.writeAuthorizationModel(model)).authorization_model_id;
  log(`wrote authorization model ${modelId}`);

  const existing = new Set((await readAllTuples(store)).map(tupleKey));
  const missing = tuples.filter((t) => !existing.has(tupleKey(t)));
  if (missing.length > 0) {
    await store.write({ writes: missing }, { authorizationModelId: modelId });
  }
  log(`tuples: ${missing.length} written, ${tuples.length - missing.length} already present`);

  return {
    apiUrl,
    storeId,
    storeCreated,
    modelId,
    tuplesWritten: missing.length,
    tuplesSkipped: tuples.length - missing.length,
    client: new OpenFgaClient({ apiUrl, storeId, authorizationModelId: modelId }),
  };
}
