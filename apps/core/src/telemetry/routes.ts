// Route TEMPLATES for the http.route label (#729): compiled from the contract's paths (store-api.yaml and
// admin-api.yaml, passed in by src/server.ts), so a label value is always a template such as
// `/store/products/{handle}` and never a raw path with ids. Anything the contract does not define is `unmatched`.

export interface RouteMatch {
  template: string;
  params: Readonly<Record<string, string>>;
}

export interface RouteMatcher {
  match(path: string): RouteMatch | undefined;
}

export const UNMATCHED_ROUTE = 'unmatched';

type Segment = { literal: string } | { param: string };

interface Compiled {
  template: string;
  segments: Segment[];
}

const split = (path: string): string[] => path.split('/').filter((s) => s.length > 0);

/** Literal segments win over parameters, position by position: `/store/products/search` before `/store/products/{handle}`. */
function bySpecificity(a: Compiled, b: Compiled): number {
  for (let i = 0; i < a.segments.length; i++) {
    const la = 'literal' in a.segments[i]!;
    const lb = 'literal' in b.segments[i]!;
    if (la !== lb) return la ? -1 : 1;
  }
  return a.template < b.template ? -1 : a.template > b.template ? 1 : 0;
}

export function compileRouteMatcher(templates: Iterable<string>): RouteMatcher {
  const bySegmentCount = new Map<number, Compiled[]>();
  for (const template of new Set(templates)) {
    const segments: Segment[] = split(template).map((s) =>
      /^\{[^/{}]+\}$/.test(s) ? { param: s.slice(1, -1) } : { literal: s },
    );
    const list = bySegmentCount.get(segments.length) ?? [];
    list.push({ template, segments });
    bySegmentCount.set(segments.length, list);
  }
  for (const list of bySegmentCount.values()) list.sort(bySpecificity);

  return {
    match(path) {
      const parts = split(path);
      for (const c of bySegmentCount.get(parts.length) ?? []) {
        const params: Record<string, string> = {};
        const ok = c.segments.every((seg, i) => {
          if ('literal' in seg) return seg.literal === parts[i];
          params[seg.param] = parts[i]!;
          return true;
        });
        if (ok) return { template: c.template, params };
      }
      return undefined;
    },
  };
}
