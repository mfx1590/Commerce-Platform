// Public API of the bootstrap verifier (issue #8). Read-only checks; see verify.ts and README.md.
export { formatReport, verifyBootstrap } from './verify';
export type { Finding, Severity, VerifyResult } from './verify';
