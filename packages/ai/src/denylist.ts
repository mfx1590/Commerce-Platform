// Customer fields that may never be passed to the gateway (D8, #605), enforced twice:
// - at compile time: `complete()`'s variables are intersected with `{ [K in DeniedField]?: never }`, so a call that
//   passes one of these keys does not type-check (test/denylist.typecheck.ts);
// - at run time: every variable key, at any depth, is normalised (lower case, no `_` / `-`) and checked against
//   the same list before anything is rendered — a value typed `any` or built at run time cannot slip through.
// scripts/generate.mjs reads this list too and refuses a template that declares one of these names.
// Keep one quoted name per line: the generator parses the lines that look like `  'name',`.

export const DENIED_FIELDS = [
  'email',
  'emailAddress',
  'email_address',
  'phone',
  'phoneNumber',
  'phone_number',
  'mobile',
  'firstName',
  'first_name',
  'lastName',
  'last_name',
  'fullName',
  'full_name',
  'customerName',
  'customer_name',
  'address',
  'address1',
  'address2',
  'address_1',
  'address_2',
  'addressLine1',
  'addressLine2',
  'address_line_1',
  'address_line_2',
  'street',
  'streetAddress',
  'street_address',
  'houseNumber',
  'house_number',
  'postalCode',
  'postal_code',
  'postcode',
  'zip',
  'zipCode',
  'zip_code',
  'dateOfBirth',
  'date_of_birth',
  'birthDate',
  'birth_date',
  'dob',
  'iban',
  'cardNumber',
  'card_number',
  'pan',
  'cvc',
  'cvv',
  'ssn',
  'bsn',
  'nationalId',
  'national_id',
  'passport',
  'passportNumber',
  'passport_number',
] as const;

export type DeniedField = (typeof DENIED_FIELDS)[number];

/** Adds `?: never` for every denied key: an object that carries one of them is not assignable. */
export type NoDeniedFields = { readonly [K in DeniedField]?: never };

const normalise = (key: string) => key.toLowerCase().replace(/[_-]/g, '');
const DENIED = new Set(DENIED_FIELDS.map(normalise));

/** Every denied key found in `value`, at any depth (paths like `customer.email`); empty when clean. */
export function findDeniedFields(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findDeniedFields(v, `${path}[${i}]`));
  }
  if (value && typeof value === 'object') {
    const found: string[] = [];
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const here = path ? `${path}.${key}` : key;
      if (DENIED.has(normalise(key))) found.push(here);
      found.push(...findDeniedFields(v, here));
    }
    return found;
  }
  return [];
}
