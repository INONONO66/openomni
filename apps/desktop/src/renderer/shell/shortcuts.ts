export type ShellShortcut = "toggle-sidebar";

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
  if (event.isComposing || event.altKey || event.shiftKey || event.metaKey || event.ctrlKey)
    return null;
  return event.key === "[" && !editing ? "toggle-sidebar" : null;
}
