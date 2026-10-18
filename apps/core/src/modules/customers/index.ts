// Public API of the customers module. Nothing outside this folder may import from its other files (ADR 0005).
export {
  ADDRESS_LIMIT,
  addCustomerAddress,
  customerEmailHash,
  deleteCustomerAddress,
  findCustomerForSubject,
  listCustomerAddresses,
  registerCustomer,
  resolveCustomer,
  updateCustomer,
  updateCustomerAddress,
} from './service';
export type {
  AddressInput,
  AddressPatch,
  Customer,
  CustomerAddress,
  CustomerIdentity,
  CustomerPatch,
  CustomerScope,
  CustomerStatus,
  RegisterCustomerInput,
} from './types';
// Admin API customer operations (#414)
export {
  adminGetCustomer,
  adminListCustomerAddresses,
  adminListCustomers,
  adminUpdateCustomer,
  CUSTOMER_SORT_FIELDS,
  listCustomerGroups,
  toAdminCustomer,
} from './admin';
export type {
  AdminCustomer,
  AdminCustomerAddress,
  AdminCustomerPatch,
  CustomerGroup,
  CustomerListQuery,
  CustomerSortField,
} from './admin';
// GDPR erasure and export (#414)
export {
  buildCustomerExport,
  eraseCustomer,
  eraseMe,
  erasedEmail,
  requestCustomerExport,
} from './gdpr';
export type {
  CustomerExport,
  CustomerExportOrder,
  CustomerExportOrderLine,
  EraseResult,
} from './gdpr';
// Consent ledger (#471)
export { adminListCustomerConsents, getMyConsents, putMyConsents } from './consent';
export type { CustomerConsent, PutMyConsentsInput } from './consent';
export {
  CONSENT_PURPOSES,
  CONSENT_SOURCES,
  consentLedger,
  DEFAULT_POLICY_VERSION,
  recordConsent,
  storePolicyVersion,
} from './consent-ledger';
export type {
  ConsentAnswer,
  ConsentDecision,
  ConsentPurpose,
  ConsentSource,
} from './consent-ledger';
export {
  customersAdminRouter,
  CUSTOMER_CONSENTS_PATH,
  CUSTOMER_EXPORT_PATH,
  CUSTOMER_EXPORTS_PATH,
  sendExport,
} from './http';
// Export delivery (#472)
export {
  adminGetCustomerExport,
  adminListCustomerExports,
  buildPendingExports,
  claimExportRequests,
  DEFAULT_EXPORT_MAX_BYTES,
  DEFAULT_EXPORT_TTL_DAYS,
  EXPORT_CLAIM_LOOKBACK,
  EXPORT_FORMAT,
  getMyExport,
  listMyExports,
  purgeExpiredExports,
} from './export-delivery';
export type {
  AdminCustomerExportSummary,
  BuildOptions,
  BuildResult,
  CustomerExportSummary,
  ExportDownload,
} from './export-delivery';
