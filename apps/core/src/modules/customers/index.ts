// Public API of the customers module. Nothing outside this folder may import from its other files (ADR 0005).
export {
  customerEmailHash,
  findCustomerForSubject,
  registerCustomer,
  resolveCustomer,
} from './service';
export type {
  Customer,
  CustomerIdentity,
  CustomerScope,
  CustomerStatus,
  RegisterCustomerInput,
} from './types';
