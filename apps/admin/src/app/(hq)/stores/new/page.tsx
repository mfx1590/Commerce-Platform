import { redirect } from 'next/navigation';

/**
 * "Brand onboarding step 1" (`createStore` alone) is replaced by the onboarding wizard (#428 B),
 * which creates the store with its legal entity, domain, channel and key in one transaction.
 */
export default function NewStorePage(): never {
  redirect('/onboarding');
}
