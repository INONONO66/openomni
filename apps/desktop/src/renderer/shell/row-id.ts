import type { SessionId } from "../mock/console";

/**
 * The DOM id of a session row.
 *
 * It exists as one function rather than a template at two call sites because
 * `aria-activedescendant` on the search field and `id` on the row have to agree
 * exactly — a mismatch is silent, and it makes the field announce nothing while
 * looking correct in every screenshot.
 */
export function rowId(id: SessionId): string {
  return `session-row-${id}`;
}

/** The element the search field filters, for `aria-controls`. */
export const TREE_ID = "session-tree";
