// Public API of @platform/auth-sdk. Nothing outside this package may import from src/* directly.
export const PACKAGE_NAME = '@platform/auth-sdk' as const;

// OpenFGA: model + seed helpers (infra/openfga) and the client factory.
export {
  OPENFGA_DIR,
  loadAuthorizationModel,
  loadSeedTuples,
  modelFromDsl,
  readModelDsl,
} from './fga/model.js';
export { createOpenFgaClient, DEFAULT_OPENFGA_API_URL } from './fga/client.js';
export type { OpenFgaClientOptions } from './fga/client.js';
export { seedOpenFga, DEFAULT_OPENFGA_STORE_NAME } from './fga/seed.js';
export type { SeedOpenFgaOptions, SeedOpenFgaResult } from './fga/seed.js';
export type { TupleKey } from '@openfga/sdk';
