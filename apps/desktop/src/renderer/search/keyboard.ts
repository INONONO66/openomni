import type { SessionId } from "../mock/console";

/**
 * The search field's keyboard contract, as a pure function.
 *
 * There is no DOM in this test runner, so the keyboard flow is expressed as a
 * reducer over explicit state and verified directly. That is not a workaround:
 * a keyboard contract written as a pile of handlers is a contract nobody can
 * read, and the interesting decisions here — what Esc means when the field has
 * text versus when it is empty, where focus lands after Enter — are decisions
 * about state, not about events.
 *
 * The view's job is reduced to translating a real key event into one `Intent`
 * and executing the returned `Effect`s.
 */

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

/**
 * What the view must do that state cannot express. Focus is an imperative fact
 * about the document, so it is returned rather than stored: storing "should be
 * focused" and reconciling it in an effect is how a field ends up fighting the
 * operator for the caret.
 */
export type Effect =
  | { readonly kind: "focusField" }
  | { readonly kind: "focusSelectedRow" }
  | { readonly kind: "select"; readonly id: SessionId };

export interface Transition {
  readonly state: SearchState;
  readonly effects: readonly Effect[];
}

export const INITIAL: SearchState = { query: "", activeId: null };

/**
 * `sequence` is the visible result order — the attention engine's sequence
 * after filtering. It is a parameter rather than state because it is derived:
 * two sources of truth for "what is on screen" is how an active row ends up
 * pointing at a row that is no longer painted.
 */
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
      // A new query invalidates the active row rather than clamping it. The
      // operator is still describing what they want; pre-selecting a row from a
      // half-typed query is the view deciding on their behalf.
      return { state: { query: intent.query, activeId: null }, effects: [] };

    case "escape":
      // Two meanings, decided by whether there is anything to undo. Esc with
      // text clears the query and keeps the caret; Esc on an empty field is
      // "leave", and leaving returns focus to the row the operator is actually
      // working in — not to nowhere.
      return state.query.length > 0
        ? { state: INITIAL, effects: [{ kind: "focusField" }] }
        : { state: INITIAL, effects: [{ kind: "focusSelectedRow" }] };

    case "move": {
      if (sequence.length === 0) return { state, effects: [] };
      const next = step(state.activeId, intent.delta, sequence);
      return { state: { ...state, activeId: next }, effects: [] };
    }

    case "commit": {
      // Enter without an arrow-key active row commits the first result: the
      // operator typed a query and pressed Enter, and the first row is what the
      // query said. Focus returns to the field so the next keystroke keeps
      // narrowing instead of landing on a row.
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

/**
 * Walk the visible sequence. Entering from the field lands on the first row
 * going down and the last going up; the ends CLAMP rather than wrap, because a
 * list that loops silently makes "am I at the bottom" unanswerable without
 * counting.
 */
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

/**
 * Translate a key event into an intent, or `null` when the key is not ours.
 *
 * Returning `null` is what keeps the field from swallowing keys it has no
 * behavior for: a control that calls `preventDefault` on everything breaks text
 * selection, the caret, and every OS shortcut that passes through it.
 */
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
