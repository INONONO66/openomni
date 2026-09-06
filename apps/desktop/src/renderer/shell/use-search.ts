import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Boundary, Ordered } from "../attention";
import type { Session, SessionId } from "../mock/console";
import {
  type Filtered,
  filterOrdered,
  INITIAL,
  intentFor,
  reduce,
  type SearchFields,
  type SearchState,
} from "../search";

/**
 * The search field's React binding: it holds the reducer's state, registers the
 * global accelerator, and executes the effects the reducer returns.
 *
 * Every decision about what a key MEANS lives in `renderer/search/keyboard.ts`.
 * This hook only translates events into intents and effects into DOM calls, so
 * the behavior stays testable without a DOM and this file stays free of
 * branching that a test cannot reach.
 */
export interface Search {
  readonly state: SearchState;
  readonly filtered: Filtered;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onValueChange: (value: string) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  /** The count line under the field, or undefined while the field is at rest. */
  readonly resultLabel: string | undefined;
}

export function useSearch({
  ordered,
  sessions,
  projectNames,
  onSelect,
  focusSelectedRow,
}: {
  readonly ordered: Ordered;
  readonly sessions: readonly Session[];
  readonly projectNames: ReadonlyMap<string, string>;
  readonly onSelect: (id: SessionId, boundary?: Boundary | null) => void;
  /** Where Esc returns the caret when there is nothing left to clear. */
  readonly focusSelectedRow: () => void;
}): Search {
  const [state, setState] = useState<SearchState>(INITIAL);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * A row's searchable text: its own name, its project's name, then the
   * engine's reason line. All three are things the operator can see on screen,
   * which is the test for whether a field belongs here — searching text the
   * surface never shows produces matches that look like bugs.
   */
  const fieldsFor = useCallback(
    (id: SessionId, reason: string): SearchFields => {
      const session = sessions.find((candidate) => candidate.id === id);
      return [
        session?.name ?? id,
        projectNames.get(session?.projectId ?? "") ?? "",
        reason.length > 0 ? reason : (session?.state ?? ""),
      ];
    },
    [sessions, projectNames],
  );

  const filtered = useMemo(
    () => filterOrdered(ordered, state.query, fieldsFor),
    [ordered, state.query, fieldsFor],
  );

  // The visible sequence is what the arrow keys walk, so the reducer is always
  // handed the CURRENT one rather than a copy captured when a key was pressed.
  const sequence = filtered.sequence;
  const sequenceRef = useRef(sequence);
  sequenceRef.current = sequence;

  const run = useCallback(
    (intent: Parameters<typeof reduce>[1]) => {
      setState((previous) => {
        const { state: next, effects } = reduce(previous, intent, sequenceRef.current);
        for (const effect of effects) {
          switch (effect.kind) {
            case "focusField":
              inputRef.current?.focus();
              break;
            case "focusSelectedRow":
              focusSelectedRow();
              break;
            case "select":
              // Not a boundary: the operator is still in the field, and
              // reordering the results they are arrowing through is the reflow
              // the stability rule exists to prevent.
              onSelect(effect.id, null);
              break;
            default:
              throw new Error(`unhandled search effect: ${JSON.stringify(effect)}`);
          }
        }
        return next;
      });
    },
    [onSelect, focusSelectedRow],
  );

  /**
   * ⌘K from anywhere in the window. Registered ONCE on the document, because
   * the accelerator's whole point is that it works when the field does not have
   * focus — a handler on the field could never fire.
   */
  useEffect(() => {
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      run({ kind: "shortcut" });
    };
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, [run]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      const intent = intentFor(event.key, event.metaKey || event.ctrlKey);
      // A key with no intent passes through untouched: a field that calls
      // preventDefault on everything breaks the caret and every OS shortcut.
      if (intent === null || intent.kind === "shortcut") return;
      event.preventDefault();
      run(intent);
    },
    [run],
  );

  return {
    state,
    filtered,
    inputRef,
    onValueChange: useCallback((query: string) => run({ kind: "type", query }), [run]),
    onKeyDown,
    resultLabel: labelFor(filtered),
  };
}

/**
 * The count line. Absent at rest, a plural-correct count while filtering, and
 * one sentence when nothing matches — the zero case is the only one that needs
 * words, because a bare `0 results` reads like a broken query rather than an
 * answer.
 */
function labelFor(filtered: Filtered): string | undefined {
  if (filtered.unfiltered) return undefined;
  if (filtered.total === 0) return "no sessions match";
  return `${filtered.total} result${filtered.total === 1 ? "" : "s"}`;
}
