import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Boundary, Ordered } from "../attention";
import type { Session, SessionId } from "../state/store";
import {
  type Filtered,
  filterOrdered,
  INITIAL,
  intentFor,
  reduce,
  type SearchFields,
  type SearchState,
} from "../search";

export interface Search {
  readonly state: SearchState;
  /** Whether the section header is showing the field instead of its label. */
  readonly searching: boolean;
  readonly setSearching: (searching: boolean) => void;
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
  onSelect,
  focusSelectedRow,
  defaultSearching = false,
  onSearchingChange,
}: {
  readonly ordered: Ordered;
  readonly sessions: readonly Session[];
  readonly onSelect: (id: SessionId, boundary?: Boundary | null) => void;
  /** Where Esc returns the caret when there is nothing left to clear. */
  readonly focusSelectedRow: () => void;
  /** The initial mode only; the hook owns it from then on. */
  readonly defaultSearching?: boolean;
  readonly onSearchingChange?: ((searching: boolean) => void) | undefined;
}): Search {
  const [state, setState] = useState<SearchState>(INITIAL);
  // The field exists only while searching, and it autofocuses on mount — so
  // "focus the field" is "open it", and the ref is for the already-open case.
  const [searching, setSearchingState] = useState(defaultSearching);
  const inputRef = useRef<HTMLInputElement>(null);
  const stateRef = useRef(state);
  const searchingRef = useRef(searching);

  const fieldsFor = useCallback(
    (id: SessionId): SearchFields => {
      const session = sessions.find((candidate) => candidate.id === id);
      return [session?.title ?? id, session?.projectId ?? ""];
    },
    [sessions],
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
      const { state: next, effects } = reduce(stateRef.current, intent, sequenceRef.current);
      stateRef.current = next;
      setState(next);
      for (const effect of effects) {
        switch (effect.kind) {
          case "focusField":
            if (!searchingRef.current) {
              searchingRef.current = true;
              onSearchingChange?.(true);
              setSearchingState(true);
            }
            inputRef.current?.focus();
            break;
          case "close":
            searchingRef.current = false;
            onSearchingChange?.(false);
            setSearchingState(false);
            focusSelectedRow();
            break;
          case "select":
            onSelect(effect.id, null);
            break;
          default:
            throw new Error(`unhandled search effect: ${JSON.stringify(effect)}`);
        }
      }
    },
    [onSelect, focusSelectedRow, onSearchingChange],
  );

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
    searching,
    setSearching: useCallback(
      (next: boolean) => {
        if (next) run({ kind: "shortcut" });
        else run({ kind: "escape" });
      },
      [run],
    ),
    filtered,
    inputRef,
    onValueChange: useCallback((query: string) => run({ kind: "type", query }), [run]),
    onKeyDown,
    resultLabel: labelFor(filtered),
  };
}

function labelFor(filtered: Filtered): string | undefined {
  if (filtered.unfiltered) return undefined;
  if (filtered.total === 0) return "no sessions match";
  return `${filtered.total} result${filtered.total === 1 ? "" : "s"}`;
}
