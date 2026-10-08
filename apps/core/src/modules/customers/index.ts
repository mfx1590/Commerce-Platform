// Public API of the customers module. Nothing outside this folder may import from its other files (ADR 0005).
export {
  ADDRESS_LIMIT,
  addCustomerAddress,
  customerEmailHash,
  findCustomerForSubject,
  listCustomerAddresses,
  registerCustomer,
  resolveCustomer,
  updateCustomer,
} from './service';
export type {
  AddressInput,
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
