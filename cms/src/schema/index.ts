import type { TypeDefinition } from './define.js';
import { documentTypes } from './documents.js';
import { objectTypes } from './objects.js';

export * from './define.js';
export * from './documents.js';
export * from './objects.js';
export * from './validators.js';

/** The whole registry, as `sanity.config.ts` hands it to the Studio. */
export const schemaTypes: readonly TypeDefinition[] = [...objectTypes, ...documentTypes];
