/**
 * Row selection for a server-paginated table.
 *
 * The rule this encodes: **selecting a page never silently selects the rest of the result set.**
 * Ticking the header checkbox selects the rows you can see. Acting on everything that matches the
 * current filter is a second, explicit choice — `selectAllMatching` — because "delete selected"
 * meaning 20 rows or 4 000 rows depending on a checkbox nobody read is how accidents happen.
 *
 * Pure: no React, no `next/*`.
 */

export type Selection =
  /** Exactly these ids, wherever they were ticked. */
  | { readonly mode: 'rows'; readonly ids: ReadonlySet<string> }
  /** Everything the current filter matches, minus any the user then unticked. */
  | {
      readonly mode: 'all-matching';
      readonly excluded: ReadonlySet<string>;
      readonly total: number;
    };

export const EMPTY_SELECTION: Selection = { mode: 'rows', ids: new Set() };

export function isRowSelected(selection: Selection, id: string): boolean {
  return selection.mode === 'rows' ? selection.ids.has(id) : !selection.excluded.has(id);
}

export function toggleRow(selection: Selection, id: string): Selection {
  if (selection.mode === 'rows') {
    const ids = new Set(selection.ids);
    if (!ids.delete(id)) ids.add(id);
    return { mode: 'rows', ids };
  }
  const excluded = new Set(selection.excluded);
  if (!excluded.delete(id)) excluded.add(id);
  return { mode: 'all-matching', excluded, total: selection.total };
}

export function isPageFullySelected(selection: Selection, pageIds: readonly string[]): boolean {
  return pageIds.length > 0 && pageIds.every((id) => isRowSelected(selection, id));
}

/** Header checkbox: select every row on this page, or clear them — never beyond the page. */
export function togglePage(selection: Selection, pageIds: readonly string[]): Selection {
  const selectAll = !isPageFullySelected(selection, pageIds);

  if (selection.mode === 'rows') {
    const ids = new Set(selection.ids);
    for (const id of pageIds) {
      if (selectAll) ids.add(id);
      else ids.delete(id);
    }
    return { mode: 'rows', ids };
  }

  const excluded = new Set(selection.excluded);
  for (const id of pageIds) {
    if (selectAll) excluded.delete(id);
    else excluded.add(id);
  }
  return { mode: 'all-matching', excluded, total: selection.total };
}

/** The explicit escalation, offered only after a full page is already ticked. */
export function selectAllMatching(total: number): Selection {
  return { mode: 'all-matching', excluded: new Set(), total };
}

export function clearSelection(): Selection {
  return EMPTY_SELECTION;
}

export function selectionCount(selection: Selection): number {
  return selection.mode === 'rows'
    ? selection.ids.size
    : Math.max(0, selection.total - selection.excluded.size);
}

export function isEmptySelection(selection: Selection): boolean {
  return selectionCount(selection) === 0;
}

/**
 * True when we should offer "select all N matching": the visible page is fully ticked, there are
 * more rows behind the filter, and the user has not already escalated.
 */
export function canOfferSelectAll(
  selection: Selection,
  pageIds: readonly string[],
  total: number,
): boolean {
  return (
    selection.mode === 'rows' &&
    pageIds.length > 0 &&
    isPageFullySelected(selection, pageIds) &&
    total > pageIds.length
  );
}

/** Wording a bulk action can put in a confirmation, so the count is never ambiguous. */
export function describeSelection(selection: Selection): string {
  const count = selectionCount(selection);
  if (count === 0) return 'Nothing selected';
  const noun = count === 1 ? 'row' : 'rows';
  return selection.mode === 'all-matching'
    ? `All ${count} ${noun} matching the current filter`
    : `${count} ${noun} selected`;
}
