import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Console, ConsoleContent } from "../src/console";
import { SHELL, STRIP } from "./fixture";

const browser = globalThis;
let host: HTMLElement;
let root: Root;
beforeEach(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  await GlobalRegistrator.unregister();
});

function node(selector: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`Missing ${selector}`);
  return element;
}

const records = ["a", "b", "c"].map((id) => ({ id, title: id, icon: null, active: id === "a" }));

test("tab keyboard navigation wraps, updates panel ownership and scrolls selection into view", async () => {
  const scroll = spyOn(browser.HTMLElement.prototype, "scrollIntoView");
  function Frame() {
    const [active, setActive] = useState("a");
    return (
      <Console
        shell={SHELL}
        sidebar={null}
        strip={{
          ...STRIP,
          tabs: records.map((tab) => ({ ...tab, active: tab.id === active })),
          onActivate: setActive,
        }}
      />
    );
  }
  try {
    await act(() => root.render(<Frame />));
    expect(scroll).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    for (const [from, key, to] of [
      ["a", "ArrowLeft", "c"],
      ["c", "ArrowRight", "a"],
      ["a", "End", "c"],
      ["c", "Home", "a"],
    ]) {
      const event = new browser.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(() => node(`#tab-${from}`).dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement === node(`#tab-${to}`)).toBe(true);
      expect(node(`#tab-${to}`).tabIndex).toBe(0);
      expect(node(`#tab-${to}`).getAttribute("aria-selected")).toBe("true");
      expect(node('[role="tabpanel"]').getAttribute("aria-labelledby")).toBe(`tab-${to}`);
      expect(node(`#tab-${to}`).getAttribute("aria-controls")).toBe(node('[role="tabpanel"]').id);
    }
    const unrelated = new browser.KeyboardEvent("keydown", {
      key: "x",
      bubbles: true,
      cancelable: true,
    });
    await act(() => node("#tab-a").dispatchEvent(unrelated));
    expect(unrelated.defaultPrevented).toBe(false);
    await act(() => {
      node('[data-ui="Tab.Close"]').focus();
      node('[data-ui="Tab.Close"]').dispatchEvent(
        new browser.KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
    });
    expect(node("#tab-a").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement === node('[data-ui="Tab.Close"]')).toBe(true);
  } finally {
    scroll.mockRestore();
  }
});

test("activation, auxiliary close and close-button actions remain distinct", async () => {
  const activated: string[] = [];
  const closed: string[] = [];
  let created = 0;
  await act(() =>
    root.render(
      <Console
        shell={SHELL}
        sidebar={null}
        strip={{
          ...STRIP,
          tabs: records,
          onActivate: (id) => activated.push(id),
          onClose: (id) => closed.push(id),
          onCreate: () => {
            created += 1;
          },
        }}
      />,
    ),
  );
  const tab = node("#tab-b");
  const close = tab.parentElement?.querySelector<HTMLElement>('[data-ui="Tab.Close"]');
  if (!close) throw new Error("Missing close control");
  await act(() => tab.click());
  expect(activated).toEqual(["b"]);
  for (const target of [tab, close]) {
    const right = new browser.MouseEvent("auxclick", {
      bubbles: true,
      button: 2,
      cancelable: true,
    });
    await act(() => target.dispatchEvent(right));
    expect(right.defaultPrevented).toBe(false);
    const middle = new browser.MouseEvent("auxclick", {
      bubbles: true,
      button: 1,
      cancelable: true,
    });
    await act(() => target.dispatchEvent(middle));
    expect(middle.defaultPrevented).toBe(true);
  }
  const press = new browser.PointerEvent("pointerdown", { bubbles: true, cancelable: true });
  await act(() => close.dispatchEvent(press));
  expect(press.defaultPrevented).toBe(true);
  await act(() => close.click());
  expect(closed).toEqual(["b", "b", "b"]);
  expect(activated).toEqual(["b"]);
  await act(() => node('[data-ui="TabStrip.Create"]').click());
  expect(created).toBe(1);
});

test("app-owned content replaces the empty transcript without mounting a composer", async () => {
  await act(() =>
    root.render(
      <ConsoleContent>
        <ul data-owned="list">
          <li />
        </ul>
      </ConsoleContent>,
    ),
  );
  expect(node('[data-ui="Console.Content"]').contains(node('[data-owned="list"]'))).toBe(true);
  expect(host.querySelector("textarea")).toBeNull();
  await act(() => root.render(<ConsoleContent />));
  expect(host.querySelector('[data-owned="list"]')).toBeNull();
  expect(host.querySelector("textarea")).toBeNull();
});
