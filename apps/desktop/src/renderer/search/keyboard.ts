import type { SessionId } from "../state/store";

export type Intent =
  /** The global ⌘K / Ctrl+K accelerator. */
  | { readonly kind: "shortcut" }
  | { readonly kind: "type"; readonly query: string }
  | { readonly kind: "escape" }
  | { readonly kind: "move"; readonly delta: 1 | -1 }
  | { readonly kind: "commit" };

export interface SearchState {
  readonly query: string;
  /** The row the arrow keys are on, or null when the field owns the caret. */
  readonly activeId: SessionId | null;
}

export type Effect =
  /** Open the field (it lives in the section header only while searching) and put the caret in it. */
  | { readonly kind: "focusField" }
  /** Close the field and return focus to the row the operator is working in. */
  | { readonly kind: "close" }
  | { readonly kind: "select"; readonly id: SessionId };

interface Transition {
  readonly state: SearchState;
  readonly effects: readonly Effect[];
}

export const INITIAL: SearchState = { query: "", activeId: null };

export function reduce(
  state: SearchState,
  intent: Intent,
  sequence: readonly SessionId[],
): Transition {
  switch (intent.kind) {
    case "shortcut":
      // Reachable from anywhere in the window, and it does not clear: an
      // operator hitting ⌘K mid-query means "put me back in the field".
      return { state, effects: [{ kind: "focusField" }] };

    case "type":
      return { state: { query: intent.query, activeId: null }, effects: [] };

    case "escape":
      return { state: INITIAL, effects: [{ kind: "close" }] };

    case "move": {
      if (sequence.length === 0) return { state, effects: [] };
      const next = step(state.activeId, intent.delta, sequence);
      return { state: { ...state, activeId: next }, effects: [] };
    }

    case "commit": {
      const target = state.activeId ?? sequence[0];
      if (target === undefined) return { state, effects: [] };
      return {
        state: { ...state, activeId: target },
        effects: [{ kind: "select", id: target }, { kind: "focusField" }],
      };
    }

    default:
      return unreachable(intent);
  }
}

function step(
  activeId: SessionId | null,
  delta: 1 | -1,
  sequence: readonly SessionId[],
): SessionId | null {
  if (activeId === null) {
    return (delta === 1 ? sequence[0] : sequence[sequence.length - 1]) ?? null;
  }

  const index = sequence.indexOf(activeId);
  // An active row that left the results is not a position to step from.
  if (index === -1) return sequence[0] ?? null;

  const target = index + delta;
  if (target < 0 || target >= sequence.length) return activeId;
  return sequence[target] ?? activeId;
}

export function intentFor(key: string, modifier: boolean): Intent | null {
  if (modifier && key.toLowerCase() === "k") return { kind: "shortcut" };
  switch (key) {
    case "Escape":
      return { kind: "escape" };
    case "ArrowDown":
      return { kind: "move", delta: 1 };
    case "ArrowUp":
      return { kind: "move", delta: -1 };
    case "Enter":
      return { kind: "commit" };
    default:
      return null;
  }
}

function unreachable(value: never): never {
  throw new Error(`unhandled search intent: ${JSON.stringify(value)}`);
}
