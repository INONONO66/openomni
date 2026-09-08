/**
 * The frame's keyboard, as one table. The renderer owns these (no IPC round
 * trip for a cursor move), and the table is a pure function of the key so the
 * rules can be asserted without a document.
 *
 *   ⌘[ / ⌘]   history back / forward
 *   [         toggle the sidebar — Linear's key, bare, and only while the
 *             Owner is not typing: a `[` in the composer is a bracket.
 */
export type ShellShortcut = "back" | "forward" | "toggle-sidebar";

/** The facts about a keydown the table reads; a `KeyboardEvent` satisfies it. */
export interface ShellKey {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
}

/** `editing`: the key would be typed rather than heard (a field, editable content). */
export function shellShortcut(event: ShellKey, editing: boolean): ShellShortcut | null {
  if (event.isComposing || event.altKey || event.shiftKey) return null;
  if (event.metaKey || event.ctrlKey) {
    if (event.key === "[") return "back";
    if (event.key === "]") return "forward";
    return null;
  }
  return event.key === "[" && !editing ? "toggle-sidebar" : null;
}
