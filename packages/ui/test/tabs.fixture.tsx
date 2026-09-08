import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import { SHELL, STRIP } from "./fixture";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Console, ConsoleContent } = await import("../src/console");
const { HistoryMenu } = await import("../src/history-menu");

const cleanups: (() => void)[] = [];
afterEach(async () => {
  await act(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
});
afterAll(() => GlobalRegistrator.unregister());

async function mount(content: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  await act(async () => root.render(content));
  return { host, render: (next: ReactNode) => act(async () => root.render(next)) };
}

function node(root: ParentNode, selector: string): HTMLElement {
  const result = root.querySelector<HTMLElement>(selector);
  if (result === null) throw new Error(`Missing ${selector}`);
  return result;
}

const records = ["a", "b", "c"].map((id) => ({
  id,
  title: `Title ${id}`,
  icon: <svg aria-hidden="true" data-icon={id} />,
  active: id === "a",
}));

function frame(active: string, onClose = (_id: string) => undefined) {
  return (
    <Console
      content={
        <ConsoleContent key={active}>
          <p data-content={active} />
        </ConsoleContent>
      }
      shell={SHELL}
      sidebar={null}
      strip={{
        ...STRIP,
        tabs: records.map((tab) => ({ ...tab, active: tab.id === active })),
        onClose,
      }}
    />
  );
}

describe("real tabs", () => {
  test("mounted anatomy, generic icons, active panel links, reserved close geometry and overflow", async () => {
    const { host } = await mount(frame("a"));
    const list = node(host, '[data-ui="TabStrip.List"]');
    expect(list.getAttribute("role")).toBe("tablist");
    expect(list.getAttribute("aria-label")).toBeTruthy();
    expect(list.className).toContain("overflow-x-auto");
    expect(list.contains(node(host, '[data-ui="TabStrip.Create"]'))).toBe(false);
    expect(host.querySelectorAll('[data-ui="Tab"]')).toHaveLength(3);
    for (const record of records) {
      const button = node(host, `#tab-${record.id}`);
      const wrapper = button.parentElement;
      if (wrapper === null) throw new Error("Missing wrapper");
      expect(wrapper.dataset.ui).toBe("Tab");
      expect(wrapper.className).toContain("group/tab no-drag");
      expect(wrapper.className).toContain("min-w-24");
      expect(wrapper.className).toContain("max-w-56");
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("role")).toBe("tab");
      expect(button.getAttribute("aria-label")).toBe(record.title);
      expect(button.getAttribute("aria-selected")).toBe(String(record.active));
      expect(button.tabIndex).toBe(record.active ? 0 : -1);
      expect(button.getAttribute("aria-controls")).toBe(record.active ? "tab-panel-a" : null);
      expect(node(wrapper, '[data-ui="Tab.Icon"]').className).toContain("size-3.5");
      expect(wrapper.querySelector(`[data-icon="${record.id}"]`)).not.toBeNull();
      expect(node(wrapper, '[data-ui="Tab.Title"]').className).toContain("truncate");
      const close = node(wrapper, '[data-ui="Tab.Close"]');
      expect(close.parentElement).toBe(wrapper);
      expect(button.contains(close)).toBe(false);
      expect(close.dataset.size).toBe("xs");
      expect(close.tabIndex).toBe(0);
      expect(close.className).toContain(record.active ? "opacity-100" : "opacity-0");
      if (!record.active) {
        expect(close.className).toContain("group-hover/tab:opacity-100");
        expect(close.className).toContain("group-focus-within/tab:opacity-100");
      }
    }
    expect(node(host, '[role="tabpanel"]').id).toBe("tab-panel-a");
    expect(node(host, '[role="tabpanel"]').getAttribute("aria-labelledby")).toBe("tab-a");
    expect(host.querySelector('[data-ui="Console.Content"]')).not.toBeNull();
    expect(host.querySelector("button button")).toBeNull();
  });

  test("pressing the close control never takes focus: its pointerdown is cancelled", async () => {
    const { host } = await mount(frame("a"));
    const close = node(host, '[data-ui="Tab.Close"]');
    const press = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
    await act(() => close.dispatchEvent(press));
    expect(press.defaultPrevented).toBe(true);
  });

  test("close and middle auxiliary clicks close once without activating; right clicks never close", async () => {
    const closed: string[] = [];
    const activated: string[] = [];
    const { host } = await mount(
      <Console
        shell={SHELL}
        sidebar={null}
        strip={{
          ...STRIP,
          tabs: records,
          onActivate: (id) => activated.push(id),
          onClose: (id) => closed.push(id),
        }}
      />,
    );
    const button = node(host, "#tab-b");
    const close = node(button.parentElement ?? host, '[data-ui="Tab.Close"]');
    await act(() => close.click());
    expect(closed).toEqual(["b"]);
    await act(() => button.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 })));
    expect(closed).toEqual(["b", "b"]);
    await act(() => close.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 })));
    expect(closed).toEqual(["b", "b", "b"]);
    await act(() => button.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 2 })));
    expect(closed).toHaveLength(3);
    expect(activated).toEqual([]);
    await act(() => button.click());
    expect(activated).toEqual(["b"]);
  });

  test("Arrow keys wrap and Home/End activate and focus only from activation controls", async () => {
    function Interactive() {
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
    const { host } = await mount(<Interactive />);
    for (const [from, key, to] of [
      ["a", "ArrowLeft", "c"],
      ["c", "ArrowRight", "a"],
      ["a", "End", "c"],
      ["c", "Home", "a"],
    ]) {
      await act(() =>
        node(host, `#tab-${from}`).dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key }),
        ),
      );
      expect(document.activeElement).toBe(node(host, `#tab-${to}`));
      expect(node(host, `#tab-${to}`).getAttribute("aria-selected")).toBe("true");
    }
    const close = node(host, '[data-ui="Tab.Close"]');
    await act(() => {
      close.focus();
      close.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "End" }));
    });
    expect(document.activeElement).toBe(close);
    expect(node(host, "#tab-a").getAttribute("aria-selected")).toBe("true");
  });

  test("content changes keep the strip, trio and controls mounted; empty has no panel or composer", async () => {
    const { host, render } = await mount(frame("a"));
    const strip = node(host, '[data-ui="TabStrip"]');
    const trio = node(host, '[data-ui="TabStrip.Trio"]');
    const controls = Array.from(trio.querySelectorAll("button"));
    const content = node(host, '[data-ui="Console.Content"]');
    await render(frame("b"));
    expect(node(host, '[data-ui="TabStrip"]')).toBe(strip);
    expect(node(host, '[data-ui="TabStrip.Trio"]')).toBe(trio);
    expect(Array.from(trio.querySelectorAll("button"))).toEqual(controls);
    expect(node(host, '[data-ui="Console.Content"]')).not.toBe(content);
    await render(<Console shell={SHELL} sidebar={null} strip={STRIP} />);
    expect(node(host, '[data-ui="TabStrip"]')).toBe(strip);
    expect(host.querySelector('[role="tabpanel"]')).toBeNull();
    expect(host.querySelector('[data-ui="Composer"]')).toBeNull();
    expect(host.querySelector('[data-ui="TabStrip.Create"]')).not.toBeNull();
  });
});

describe("history menu", () => {
  const entries = Array.from({ length: 20 }, (_, index) => ({
    id: String(24 - index),
    title: `Entry ${24 - index}`,
  }));
  test.each([
    "24",
    "5",
  ])("renders the caller's order verbatim with current %s marked once and no fabricated ages", async (currentId) => {
    const jumps: string[] = [];
    const { host } = await mount(
      <HistoryMenu
        currentId={currentId}
        entries={entries}
        now={1000}
        onJump={(id) => jumps.push(id)}
      />,
    );
    await act(() => node(host, "button").click());
    const items = Array.from(
      document.querySelectorAll<HTMLElement>('[data-ui="HistoryMenu.Item"]'),
    );
    expect(items.map((item) => item.textContent)).toEqual(entries.map((entry) => entry.title));
    expect(items.filter((item) => item.getAttribute("aria-current") === "true")).toHaveLength(1);
    expect(items.every((item) => item.querySelector('[data-ui="Text"]') === null)).toBe(true);
    const last = items.at(-1);
    if (last === undefined) throw new Error("Missing last entry");
    await act(() => last.click());
    expect(jumps).toEqual(["5"]);
  });
});
