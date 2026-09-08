import { describe, expect, test } from "bun:test";
import { type ShellKey, shellShortcut } from "../src/renderer/shell/shortcuts";

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
  test("native menu accelerators never dispatch again in the renderer", () => {
    for (const value of ["[", "]", "t", "w", "Tab", "1", "9"]) {
      for (const editing of [false, true]) {
        expect(shellShortcut(key({ key: value, metaKey: true }), editing)).toBeNull();
        expect(shellShortcut(key({ key: value, ctrlKey: true }), editing)).toBeNull();
        expect(
          shellShortcut(key({ key: value, metaKey: true, shiftKey: true }), editing),
        ).toBeNull();
        expect(
          shellShortcut(key({ key: value, ctrlKey: true, shiftKey: true }), editing),
        ).toBeNull();
      }
    }
  });

  test("Given a bare [, When pressed outside a field, Then the sidebar toggles", () => {
    expect(shellShortcut(key({ key: "[" }), false)).toBe("toggle-sidebar");
  });

  test("Given a bare [, When typed into a field, Then it is a bracket", () => {
    expect(shellShortcut(key({ key: "[" }), true)).toBeNull();
    expect(shellShortcut(key({ key: "[", metaKey: true }), true)).toBeNull();
  });

  test("Given other keys or chords, When pressed, Then nothing is heard", () => {
    expect(shellShortcut(key({ key: "]" }), false)).toBeNull();
    expect(shellShortcut(key({ key: "[", altKey: true }), false)).toBeNull();
    expect(shellShortcut(key({ key: "[", shiftKey: true }), false)).toBeNull();
    expect(shellShortcut(key({ key: "[", isComposing: true }), false)).toBeNull();
    expect(shellShortcut(key({ key: "b", metaKey: true }), false)).toBeNull();
  });
});
