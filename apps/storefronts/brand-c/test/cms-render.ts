import type { ReactElement, ReactNode } from 'react';

/**
 * Resolves a React Server Component tree into plain data without a DOM: function components (sync
 * or async) are called with their props, fragments are flattened, host elements keep their tag,
 * props and children. Enough to assert headings, alt text, links and copy in the CMS suites.
 * Shared by the `cms-*` tests; not a test file itself.
 */
export interface Rendered {
  tag: string;
  props: Record<string, unknown>;
  children: (Rendered | string)[];
}

type Node = Rendered | string;

export async function render(node: ReactNode): Promise<Node[]> {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) {
    const out: Node[] = [];
    for (const child of node) out.push(...(await render(child)));
    return out;
  }
  if (node instanceof Promise) return render(await node);
  const element = node as ReactElement<Record<string, unknown>>;
  const { type, props } = element;
  if (typeof type === 'function') {
    const component = type as (p: unknown) => ReactNode | Promise<ReactNode>;
    return render(await component(props));
  }
  if (typeof type === 'string') {
    const { children, ...rest } = props;
    return [{ tag: type, props: rest, children: await render(children as ReactNode) }];
  }
  // Fragment, or a client-reference-like object we do not care about: flatten its children.
  return render(props['children'] as ReactNode);
}

export function findAll(nodes: Node[], tag: string): Rendered[] {
  const out: Rendered[] = [];
  for (const node of nodes) {
    if (typeof node === 'string') continue;
    if (node.tag === tag) out.push(node);
    out.push(...findAll(node.children, tag));
  }
  return out;
}

export function text(nodes: Node[] | Node): string {
  const list = Array.isArray(nodes) ? nodes : [nodes];
  return list
    .map((node) => (typeof node === 'string' ? node : text(node.children)))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Heading levels in document order, e.g. `[1, 2, 2, 3]`. */
export function headingLevels(nodes: Node[]): number[] {
  const out: number[] = [];
  for (const node of nodes) {
    if (typeof node === 'string') continue;
    const match = /^h([1-6])$/.exec(node.tag);
    if (match) out.push(Number(match[1]));
    out.push(...headingLevels(node.children));
  }
  return out;
}
