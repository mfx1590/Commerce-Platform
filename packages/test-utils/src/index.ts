// Public API of @platform/test-utils. Nothing outside this package may import from src/* directly.
export const PACKAGE_NAME = '@platform/test-utils' as const;

// Business-consistent event streams (real envelopes, validated against packages/events): the generated month and
// the builders behind it.
export * from './event-month.js';
