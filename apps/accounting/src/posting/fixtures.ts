// The event builders and the generated month moved to @platform/test-utils (2026-10-25, Phase 5) so the analytics
// models (#601), the reconcile (#602) and recommendations (#607) share the same business-consistent month.
// Re-exported unchanged: every accounting test and the #552 month-replay gate keep importing from here.
export * from '@platform/test-utils';
