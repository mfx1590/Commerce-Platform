import { OpenFgaClient } from '@openfga/sdk';

export interface OpenFgaClientOptions {
  /** HTTP API base, e.g. http://localhost:8081 (`OPENFGA_API_URL`). */
  apiUrl?: string;
  /** `OPENFGA_STORE_ID`; optional for store-management calls. */
  storeId?: string;
  /** `OPENFGA_MODEL_ID`; pins every check to one model version. */
  authorizationModelId?: string;
}

export const DEFAULT_OPENFGA_API_URL = 'http://localhost:8081';

/** Client for the OpenFGA HTTP API. Values default to the environment (`OPENFGA_*`). */
export function createOpenFgaClient(opts: OpenFgaClientOptions = {}): OpenFgaClient {
  const apiUrl = opts.apiUrl ?? process.env.OPENFGA_API_URL ?? DEFAULT_OPENFGA_API_URL;
  const storeId = opts.storeId ?? process.env.OPENFGA_STORE_ID;
  const authorizationModelId = opts.authorizationModelId ?? process.env.OPENFGA_MODEL_ID;
  return new OpenFgaClient({
    apiUrl,
    ...(storeId ? { storeId } : {}),
    ...(authorizationModelId ? { authorizationModelId } : {}),
  });
}
