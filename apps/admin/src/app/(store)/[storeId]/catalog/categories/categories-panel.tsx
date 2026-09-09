'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SelectField, TextField, errorMessage } from '@/components/form/fields';
import { ActionRefusal } from '@/components/states/action-refusal';
import { useContractForm } from '@/components/form/use-contract-form';
import { createCategoryAction } from '@/app/actions/catalog';
import type { AdminComponents } from '@/lib/api/admin-client';
import { categoryCreateSchema, type CategoryCreateValues } from '@/lib/forms/schemas';

type Category = AdminComponents['Category'];

interface TreeNode {
  category: Category;
  children: TreeNode[];
}

/**
 * `listCategories` returns a flat list with `parent_id`; the tree is assembled here.
 *
 * A category whose parent is missing from the list (filtered out, or not yet visible) is shown at
 * the root rather than dropped — silently hiding catalog rows would be worse than showing one at
 * the wrong depth.
 */
export function buildTree(categories: readonly Category[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const category of categories) {
    nodes.set(category.id, { category, children: [] });
  }

  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.category.parent_id;
    const parent = parentId === null ? undefined : nodes.get(parentId);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }

  const byPosition = (a: TreeNode, b: TreeNode) =>
    a.category.position - b.category.position || a.category.name.localeCompare(b.category.name);
  const sort = (list: TreeNode[]): TreeNode[] => {
    list.sort(byPosition);
    for (const node of list) sort(node.children);
    return list;
  };
  return sort(roots);
}

function Branch({ nodes, depth = 0 }: { nodes: readonly TreeNode[]; depth?: number }) {
  return (
    <ul className={depth === 0 ? 'space-y-1' : 'mt-1 space-y-1 border-l pl-4'}>
      {nodes.map((node) => (
        <li key={node.category.id}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{node.category.name}</span>
            <span className="text-muted font-mono text-xs">{node.category.handle}</span>
            {!node.category.is_active && <Badge tone="warning">inactive</Badge>}
          </div>
          {node.children.length > 0 && <Branch nodes={node.children} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

export function CategoriesPanel({
  storeId,
  categories,
}: {
  storeId: string;
  categories: readonly Category[];
}) {
  const tree = buildTree(categories);

  const { form, submit, formError, refusal, isSubmitting } = useContractForm<
    CategoryCreateValues,
    Category
  >({
    schema: categoryCreateSchema,
    action: (values) => createCategoryAction(storeId, values),
    defaultValues: { handle: '', name: '', parent_id: null, is_active: true },
    onSuccess: () => form.reset({ handle: '', name: '', parent_id: null, is_active: true }),
  });

  const errors = form.formState.errors;

  return (
    <div className="space-y-4">
      {tree.length === 0 ? (
        <p className="text-muted text-sm">No categories yet.</p>
      ) : (
        <Branch nodes={tree} />
      )}

      <form onSubmit={submit} noValidate className="border-line space-y-3 border-t pt-4">
        <ActionRefusal refusal={refusal} message={formError} />
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField
            label="Name"
            required
            error={errorMessage(errors.name)}
            {...form.register('name')}
          />
          <TextField
            label="Handle"
            required
            hint="Lower-case and hyphenated."
            error={errorMessage(errors.handle)}
            {...form.register('handle')}
          />
          <SelectField
            label="Parent"
            options={[
              { value: '', label: '— top level —' },
              ...categories.map((category) => ({ value: category.id, label: category.name })),
            ]}
            error={errorMessage(errors.parent_id)}
            {...form.register('parent_id', {
              setValueAs: (value: string) => (value === '' ? null : value),
            })}
          />
        </div>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Creating…' : 'Create category'}
        </Button>
      </form>
    </div>
  );
}
