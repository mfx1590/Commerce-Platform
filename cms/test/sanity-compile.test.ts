/**
 * The real proof that the registry is a valid Sanity schema: compile it with Sanity's own schema
 * compiler (the one the Studio runs at startup) and assert it reports no problems. `src/schema`
 * is typed against a local structural mirror, so this is where the mirror meets the real thing.
 *
 * (`sanity schema validate` on the CLI would do the same, but its loader cannot follow the
 * NodeNext `.js` import specifiers `src/**` needs for its own build.)
 */
import { createSchema } from 'sanity';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_TYPES, schemaTypes } from '../src/index.js';

interface Problem {
  severity: 'error' | 'warning';
  message: string;
}
interface ProblemGroup {
  path: { kind: string; name?: string; type?: string }[];
  problems: Problem[];
}

describe('Sanity schema compiler', () => {
  const schema = createSchema({ name: 'test', types: [...schemaTypes] });
  const validation = (schema as unknown as { _validation?: ProblemGroup[] })._validation ?? [];

  it('compiles the registry without errors or warnings', () => {
    const problems = validation.flatMap((group) =>
      group.problems.map(
        (p) =>
          `${p.severity} at ${group.path.map((s) => s.name ?? s.type ?? s.kind).join('.')}: ${p.message}`,
      ),
    );
    expect(problems).toEqual([]);
  });

  it('exposes every document type and every named object', () => {
    const names = schema.getTypeNames();
    for (const type of schemaTypes) expect(names).toContain(type.name);
    for (const type of DOCUMENT_TYPES) {
      expect(schema.get(type)?.type?.name).toBe('document');
    }
  });

  it('keeps the image alt text required after compilation', () => {
    const image = schema.get('imageWithAlt') as unknown as {
      fields?: { name: string; type: { validation?: unknown } }[];
    };
    const alt = image.fields?.find((f) => f.name === 'alt');
    expect(alt).toBeDefined();
    expect(alt?.type.validation).toBeTruthy();
  });
});
