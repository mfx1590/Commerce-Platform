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
