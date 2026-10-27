// Contract operation matcher (#632): HTTP method + raw request path → the OpenAPI operation it addresses, resolved
// BEFORE routing so the read-only / allowlist guard for service clients knows the operationId at token
// verification. It must agree with Express (4.x defaults, the core's router) or it is a bypass, so:
//
// - the path is the RAW pathname (percent-encoding untouched, query removed), exactly what Express matches;
//   segments split on `/` only, an encoded slash (`%2F`) stays inside its segment; parameter values are never
//   decoded for matching;
// - matching is case-insensitive (Express default `caseSensitive: false`) and a single trailing slash is optional
//   (default `strict: false`); nothing else is normalised (no `//` collapsing, no `.`/`..`, no decoding);
// - HEAD is answered by the GET operation, as Express routes HEAD to GET handlers;
// - when a literal and a parameter segment both fit, the literal wins at the first differing position (OpenAPI's
//   rule: `/customers/export` beats `/customers/{customerId}`). Two templates of one method that could match the
//   same path with equal precedence are refused at construction (ambiguity is a contract bug, not a tie to break).
//
// Why literal-first is safe even if a router registers routes in another order: whenever the matcher picks a
// parameter route, no literal route matches that path, so the router cannot run a literal one; and two parameter
// routes cannot both match (refused above). So the matcher is never more permissive than the router.

export interface OperationMatch {
  operationId: string;
  /** The OpenAPI path template, e.g. `/admin/stores/{storeId}/customers`. */
  template: string;
  /** Lower-case HTTP method of the matched operation (`get` for a HEAD request). */
  method: string;
}

export interface OperationMatcher {
  match(method: string | undefined, rawPath: string | undefined): OperationMatch | null;
  /** Every operation the matcher knows (tests walk it). */
  readonly operations: readonly OperationMatch[];
}

type Segment = { literal: string } | { param: true };

interface Compiled extends OperationMatch {
  segments: Segment[];
}

const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

function compileTemplate(template: string): Segment[] {
  if (!template.startsWith('/')) throw new Error(`path template must start with '/': ${template}`);
  return template
    .slice(1)
    .split('/')
    .map((s) => (/^\{[^}]+\}$/.test(s) ? { param: true as const } : { literal: s.toLowerCase() }));
}

/** Precedence key: 0 for a literal segment, 1 for a parameter — lexicographically smaller wins. */
const rank = (segments: Segment[]) => segments.map((s) => ('param' in s ? 1 : 0));

function compareRank(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** True when some concrete path could match both templates (same length, every position compatible). */
function overlap(a: Segment[], b: Segment[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => {
    const t = b[i]!;
    return 'param' in s || 'param' in t || s.literal === t.literal;
  });
}

/**
 * Builds a matcher over an OpenAPI `paths` object. Throws when two templates of one method are ambiguous (could
 * match the same path with equal precedence).
 */
export function createOperationMatcher(paths: Record<string, Record<string, unknown>>): OperationMatcher {
  const compiled: Compiled[] = [];
  for (const [template, ops] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(ops ?? {})) {
      if (!METHODS.has(method)) continue;
      const operationId = (op as { operationId?: unknown } | null)?.operationId;
      if (typeof operationId !== 'string') continue;
      compiled.push({ operationId, template, method, segments: compileTemplate(template) });
    }
  }
  for (let i = 0; i < compiled.length; i++) {
    for (let j = i + 1; j < compiled.length; j++) {
      const a = compiled[i]!;
      const b = compiled[j]!;
      if (a.method !== b.method || !overlap(a.segments, b.segments)) continue;
      if (compareRank(rank(a.segments), rank(b.segments)) === 0) {
        throw new Error(`ambiguous operations ${a.method.toUpperCase()} ${a.template} / ${b.template}`);
      }
    }
  }

  return {
    operations: compiled.map(({ operationId, template, method }) => ({ operationId, template, method })),
    match(rawMethod, rawPath) {
      if (typeof rawMethod !== 'string' || typeof rawPath !== 'string') return null;
      let method = rawMethod.toLowerCase();
      if (method === 'head') method = 'get';
      let path = rawPath.split('?')[0]!.split('#')[0]!;
      if (!path.startsWith('/')) return null;
      // Express `strict: false`: one trailing slash is optional (not on the root).
      if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
      const parts = path.slice(1).split('/');
      let best: { c: Compiled; r: number[] } | undefined;
      for (const c of compiled) {
        if (c.method !== method || c.segments.length !== parts.length) continue;
        const fits = c.segments.every((s, i) => {
          const p = parts[i]!;
          if (p === '') return false; // an empty segment (`//`) matches nothing, as in Express
          return 'param' in s || s.literal === p.toLowerCase();
        });
        if (!fits) continue;
        const r = rank(c.segments);
        if (!best || compareRank(r, best.r) < 0) best = { c, r };
      }
      return best
        ? { operationId: best.c.operationId, template: best.c.template, method: best.c.method }
        : null;
    },
  };
}
