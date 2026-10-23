export {
  createMockOdoo,
  DEFAULT_MOCK_CHART,
  DEFAULT_MOCK_JOURNALS,
  MOCK_ODOO_CREDENTIALS,
} from './mock.js';
export type { MockOdoo, MockOdooOptions, MockOdooState } from './mock.js';
export { OdooJsonRpcClient, odooCredentialsFromEnv } from './odoo-jsonrpc.js';
export type { FetchLike, OdooClientOptions, OdooCredentials } from './odoo-jsonrpc.js';
export {
  companyOf,
  DEFAULT_JOURNAL_CODES,
  mapChart,
  mapLegalEntityToCompany,
  syncLegalEntity,
} from './sync.js';
export type { ChartMappingResult, ErpSyncDeps, ErpSyncResult } from './sync.js';
export * from './types.js';
