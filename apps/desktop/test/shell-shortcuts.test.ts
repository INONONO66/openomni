import { describe, expect, test } from "bun:test";
import { type ShellKey, shellShortcut } from "../src/renderer/shell/shortcuts";

/**
 * The frame's keyboard table (docs/desktop-shell.md): ⌘[ / ⌘] move the history,
 * a bare `[` toggles the sidebar — Linear's key — unless the Owner is typing.
 */
function key(overrides: Partial<ShellKey>): ShellKey {
  return {
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    ...overrides,
  };
}

describe("the shell's keys", () => {
  test("Given ⌘[ and ⌘], When pressed, Then history moves", () => {
    expect(shellShortcut(key({ key: "[", metaKey: true }), false)).toBe("back");
    expect(shellShortcut(key({ key: "]", metaKey: true }), false)).toBe("forward");
    expect(shellShortcut(key({ key: "[", ctrlKey: true }), false)).toBe("back");
  });

  test("Given a bare [, When pressed outside a field, Then the sidebar toggles", () => {
    expect(shellShortcut(key({ key: "[" }), false)).toBe("toggle-sidebar");
  });

  test("Given a bare [, When typed into a field, Then it is a bracket", () => {
    expect(shellShortcut(key({ key: "[" }), true)).toBeNull();
    // A modified [ is a history move even from a field.
    expect(shellShortcut(key({ key: "[", metaKey: true }), true)).toBe("back");
  });

  test("Given other keys or chords, When pressed, Then nothing is heard", () => {
    expect(shellShortcut(key({ key: "]" }), false)).toBeNull();
    expect(shellShortcut(key({ key: "[", altKey: true }), false)).toBeNull();
    expect(shellShortcut(key({ key: "[", shiftKey: true }), false)).toBeNull();
    expect(shellShortcut(key({ key: "[", isComposing: true }), false)).toBeNull();
    expect(shellShortcut(key({ key: "b", metaKey: true }), false)).toBeNull();
  });
});
