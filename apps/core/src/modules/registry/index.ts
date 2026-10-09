// Public API of the registry module. Nothing outside this folder may import from its other files.
export {
  addCurrency,
  addDomain,
  addLocale,
  createApiKey,
  createSalesChannel,
  createStore,
  generatePlainKey,
  getStore,
  hashKey,
  listApiKeys,
  listCurrencies,
  listDomains,
  listLocales,
  listSalesChannels,
  listStores,
  listWarehouses,
  listLegalEntities,
  revokeApiKey,
  toStore,
  updateDomain,
  updateStore,
} from './service';
export { STORE_SORT_FIELDS } from './types';
// onboarding (#413): the workflow, the activation gate and the settings shape check
export { activateStore, onboardStore, onboardingConventions } from './onboarding';
export type { OnboardStoreResult } from './onboarding';
export { inMemoryStoreRegistrar } from './registrar';
export type { InMemoryStoreRegistrar } from './registrar';
export { READINESS_PREREQUISITES, storeReadiness } from './readiness';
export type { ReadinessPrerequisite, StoreReadiness } from './readiness';
export { STORE_SETTINGS_SHAPES, settingsProblems, validateStoreSettings } from './settings-schema';
export type { SettingsProblems } from './settings-schema';
export type {
  ApiKey,
  ApiKeyCreated,
  ApiKeyInput,
  ApiKeyType,
  Domain,
  DomainInput,
  DomainUpdate,
  Page,
  PageQuery,
  SalesChannel,
  SortOrder,
  StoreListQuery,
  StoreSortField,
  SalesChannelInput,
  SalesChannelType,
  Store,
  StoreCurrency,
  StoreInput,
  StoreLocale,
  StoreRow,
  StoreStatus,
  Warehouse,
  LegalEntity,
  LegalEntityInput,
  StoreOnboardingInput,
  StoreOnboarded,
  StoreRegistrar,
} from './types';
