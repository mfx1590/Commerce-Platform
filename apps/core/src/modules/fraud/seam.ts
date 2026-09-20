// The fraud seam is the CHECKOUT's (core #236, `src/lib/fraud-seam.ts`): `completeCart` reads it BEFORE
// authorizing — `block` → the plain 402 decline, `review` → the order is placed, `payment.metadata.fraud` written
// with the payment row and the order mirror flagged, all by the checkout itself. This file used to hold a local
// stand-in registry; it is now only the module's single import point for that seam, so `registerFraudCheck()`
// registers where `completeCart` actually looks and window 1's wiring bridge
// (`setFraudCheck(fraudModuleCheck())`) is redundant: both names below ARE the checkout's functions, so
// `currentFraudCheck()` here and there return the same object by construction.
export { currentFraudCheck, FRAUD_ALLOW, setFraudCheck } from '../checkout';
export type { FraudCheck } from '../checkout';
