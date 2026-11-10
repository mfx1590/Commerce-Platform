/**
 * The admin's security headers (Phase 6 D4, #731): the per-request nonce CSP the middleware sets,
 * and the static headers next.config.mjs sets on every response. Pure — no `next/*`.
 */

export {
  CSP_HEADER,
  NONCE_HEADER,
  contentSecurityPolicy,
  keycloakOrigin,
  newNonce,
  type CspInput,
} from './csp';
export { HSTS, PERMISSIONS_POLICY, staticSecurityHeaders } from './static-headers.mjs';
