import { describe, expect, test } from "bun:test";
import {
  type Effect,
  INITIAL,
  type Intent,
  intentFor,
  reduce,
  type SearchState,
} from "../src/renderer/search";

/**
 * The keyboard contract, asserted on the reducer that owns it.
 *
 * There is no DOM in this runner, and that is why the semantics live in a pure
 * function instead of in handlers: the interesting decisions here are about
 * STATE — what Esc means when the field has text versus when it is empty, where
 * focus lands after Enter — and a decision expressed as state can be replayed.
 * The DOM half (a real ⌘K keydown reaching the document, focus actually moving)
 * is verified in the browser by showcase/probe-search.ts.
 */
const SEQUENCE = ["first", "second", "third"] as const;

const run = (state: SearchState, intent: Intent, sequence: readonly string[] = SEQUENCE) =>
  reduce(state, intent, sequence);

const typing = (query: string, activeId: string | null = null): SearchState => ({
  query,
  activeId,
});

describe("the shortcut reaches the field from anywhere", () => {
  test("Given any state, When the shortcut fires, Then focus moves to the field", () => {
    expect(run(INITIAL, { kind: "shortcut" }).effects).toEqual([{ kind: "focusField" }]);
  });

  test("Given a live query, When the shortcut fires, Then it focuses without clearing", () => {
    // An operator hitting ⌘K mid-query means "put me back in the field", not
    // "throw away what I typed" — Esc is the key that clears.
    const transition = run(typing("back"), { kind: "shortcut" });

    expect(transition.state).toEqual(typing("back"));
    expect(transition.effects).toEqual([{ kind: "focusField" }]);
  });

  test("Given an active row, When the shortcut fires, Then the active row is kept", () => {
    expect(run(typing("b", "second"), { kind: "shortcut" }).state.activeId).toBe("second");
  });
});

describe("Esc has two meanings, decided by whether there is anything to undo", () => {
  test("Given text in the field, When Esc is pressed, Then the query clears and the caret stays", () => {
    const transition = run(typing("back"), { kind: "escape" });

    expect(transition.state).toEqual(INITIAL);
    expect(transition.effects).toEqual([{ kind: "focusField" }]);
  });

  test("Given an empty field, When Esc is pressed, Then focus returns to the selected row", () => {
    // Leaving must land somewhere the operator is working. Blurring to nowhere
    // strands the keyboard with no position at all.
    const transition = run(INITIAL, { kind: "escape" });

    expect(transition.state).toEqual(INITIAL);
    expect(transition.effects).toEqual([{ kind: "focusSelectedRow" }]);
  });

  test("Given the two Esc cases, When compared, Then they do not share an effect", () => {
    // The whole point of the branch: one keeps the caret, one gives it back.
    const withText = run(typing("x"), { kind: "escape" }).effects;
    const empty = run(INITIAL, { kind: "escape" }).effects;

    expect(withText).not.toEqual(empty);
  });

  test("Given an active row and text, When Esc is pressed, Then the active row clears too", () => {
    expect(run(typing("back", "second"), { kind: "escape" }).state.activeId).toBeNull();
  });
});

describe("typing narrows and invalidates the cursor", () => {
  test("Given a keystroke, When reduced, Then the query is stored verbatim", () => {
    expect(run(INITIAL, { kind: "type", query: "bac" }).state.query).toBe("bac");
  });

  test("Given an active row, When the query changes, Then the row is released", () => {
    // The operator is still describing what they want; keeping a row selected
    // from a half-typed query is the view deciding on their behalf.
    expect(run(typing("bac", "second"), { kind: "type", query: "back" }).state.activeId).toBeNull();
  });

  test("Given a keystroke, When reduced, Then no focus is moved", () => {
    expect(run(INITIAL, { kind: "type", query: "b" }).effects).toEqual([]);
  });
});

describe("arrows walk the visible results", () => {
  test("Given the field owns the caret, When ArrowDown fires, Then the first result activates", () => {
    expect(run(typing("b"), { kind: "move", delta: 1 }).state.activeId).toBe("first");
  });

  test("Given the field owns the caret, When ArrowUp fires, Then the last result activates", () => {
    expect(run(typing("b"), { kind: "move", delta: -1 }).state.activeId).toBe("third");
  });

  test("Given an active row, When arrows fire, Then the cursor steps one row", () => {
    expect(run(typing("b", "second"), { kind: "move", delta: 1 }).state.activeId).toBe("third");
    expect(run(typing("b", "second"), { kind: "move", delta: -1 }).state.activeId).toBe("first");
  });

  test("Given the last row, When ArrowDown fires, Then the cursor clamps and does not wrap", () => {
    // A list that loops makes "am I at the bottom" unanswerable without
    // counting, and counting is what the search was meant to avoid.
    expect(run(typing("b", "third"), { kind: "move", delta: 1 }).state.activeId).toBe("third");
    expect(run(typing("b", "first"), { kind: "move", delta: -1 }).state.activeId).toBe("first");
  });

  test("Given no results, When arrows fire, Then nothing changes", () => {
    const transition = run(typing("zzz"), { kind: "move", delta: 1 }, []);

    expect(transition.state.activeId).toBeNull();
    expect(transition.effects).toEqual([]);
  });

  test("Given the active row left the results, When arrows fire, Then the cursor recovers", () => {
    // Narrowing the query can drop the row the cursor was on. Stepping from a
    // row that is no longer painted must not strand the cursor off-screen.
    expect(run(typing("b", "gone"), { kind: "move", delta: 1 }).state.activeId).toBe("first");
  });

  test("Given arrows, When reduced, Then focus is never moved by them", () => {
    // Arrowing keeps the caret in the field so the next keystroke narrows.
    expect(run(typing("b", "first"), { kind: "move", delta: 1 }).effects).toEqual([]);
  });
});

describe("Enter selects and hands the caret back to the field", () => {
  test("Given an active row, When Enter fires, Then it is selected and focus returns", () => {
    const transition = run(typing("b", "second"), { kind: "commit" });

    expect(transition.effects).toEqual([{ kind: "select", id: "second" }, { kind: "focusField" }]);
  });

  test("Given no active row, When Enter fires, Then the first result is committed", () => {
    // The operator typed a query and pressed Enter; the first row is what the
    // query said.
    expect(run(typing("b"), { kind: "commit" }).effects).toContainEqual({
      kind: "select",
      id: "first",
    });
  });

  test("Given Enter, When reduced, Then the query survives so narrowing can continue", () => {
    expect(run(typing("back", "second"), { kind: "commit" }).state.query).toBe("back");
  });

  test("Given no results, When Enter fires, Then nothing is selected", () => {
    const transition = run(typing("zzz"), { kind: "commit" }, []);

    expect(transition.effects).toEqual([]);
  });

  test("Given Enter, When reduced, Then the field is the last effect", () => {
    // Order matters: selecting first and focusing second is what leaves the
    // caret in the field rather than on the row that just opened.
    const effects = run(typing("b", "third"), { kind: "commit" }).effects;

    expect(effects[effects.length - 1]).toEqual({ kind: "focusField" } satisfies Effect);
  });
});

describe("key translation claims only the keys it handles", () => {
  test("Given the accelerator in either modifier form, When translated, Then it is the shortcut", () => {
    expect(intentFor("k", true)).toEqual({ kind: "shortcut" });
    expect(intentFor("K", true)).toEqual({ kind: "shortcut" });
  });

  test("Given k without a modifier, When translated, Then it is just a character", () => {
    expect(intentFor("k", false)).toBeNull();
  });

  test("Given each navigation key, When translated, Then it maps to its intent", () => {
    expect(intentFor("Escape", false)).toEqual({ kind: "escape" });
    expect(intentFor("ArrowDown", false)).toEqual({ kind: "move", delta: 1 });
    expect(intentFor("ArrowUp", false)).toEqual({ kind: "move", delta: -1 });
    expect(intentFor("Enter", false)).toEqual({ kind: "commit" });
  });

  test("Given a key with no behavior, When translated, Then it is not claimed", () => {
    // A field that preventDefaults everything breaks the caret, text
    // selection, and every OS shortcut that passes through it.
    for (const key of ["a", "Tab", "Home", "ArrowLeft", "ArrowRight", "Backspace", " "]) {
      expect(intentFor(key, false)).toBeNull();
    }
  });
});

describe("the reducer is pure", () => {
  test("Given a transition, When applied, Then the input state is not mutated", () => {
    const state = typing("back", "second");
    const snapshot = { ...state };

    run(state, { kind: "type", query: "b" });
    run(state, { kind: "escape" });
    run(state, { kind: "move", delta: 1 });
    run(state, { kind: "commit" });

    expect(state).toEqual(snapshot);
  });

  test("Given the same inputs, When reduced twice, Then the transitions are identical", () => {
    const first = run(typing("b", "second"), { kind: "commit" });
    const second = run(typing("b", "second"), { kind: "commit" });

    expect(first).toEqual(second);
  });
});
