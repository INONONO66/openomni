import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useSearch, type Search } from "../src/renderer/shell/use-search";

test("search binding translates shortcuts, query edits and navigation into focus and selection", async () => {
  const window = new Window();
  const descriptors = new Map(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperties(globalThis, {
    window: { value: window, configurable: true },
    document: { value: window.document, configurable: true },
    IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let binding: Search;
  const selections: string[] = [];
  let returned = 0;
  function Harness() {
    binding = useSearch({
      ordered: { projects: [{ id: null, sessions: ["one", "two"] }] },
      sessions: [],
      onSelect: (id) => { selections.push(id); },
      focusSelectedRow: () => { returned++; },
    });
    return <input ref={binding.inputRef} onKeyDown={binding.onKeyDown} />;
  }
  try {
    await act(async () => { root.render(<Harness />); });
    await act(async () => {
      window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true }));
    });
    expect(document.activeElement === container.querySelector("input")).toBe(true);
    await act(async () => { binding.onValueChange("one"); });
    await act(async () => { expect(binding.filtered.sequence).toEqual(["one"]); });
    await act(async () => { binding.onValueChange("missing"); });
    await act(async () => { expect(binding.filtered.sequence).toEqual([]); });
    await act(async () => { binding.onValueChange(""); });
    const key = (value: string) => window.document.querySelector("input")?.dispatchEvent(new window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
    await act(async () => { key("ArrowDown"); });
    await act(async () => { expect(binding.state.activeId).toBe("one"); });
    await act(async () => { key("Enter"); });
    expect(selections).toEqual(["one"]);
    await act(async () => { key("Escape"); });
    expect(returned).toBe(1);
    await act(async () => { key("a"); });
    expect(selections).toEqual(["one"]);
  } finally {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
