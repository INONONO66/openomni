import { afterAll, expect, test } from "bun:test";
import { ScrollArea } from "../src/primitives/scroll-area";
import { Timeline } from "../src/timeline/timeline";
import { act, createRoot, unregisterDom } from "./dom-runtime";
afterAll(unregisterDom);

test("scroll area pins content appended after opening to the end", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const originalResizeObserver = globalThis.ResizeObserver;
  let resize: (() => void) | undefined;
  globalThis.ResizeObserver = class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resize = () => callback([], this);
    }
    observe() {
      // The test invokes the captured callback after appending content.
    }
    unobserve() {
      // No observed element state is retained.
    }
    disconnect() {
      // No observer resources exist in this deterministic test double.
    }
  };
  let height = 100;
  try {
    await act(() =>
      root.render(
        <ScrollArea pinToEnd>
          <div>first line</div>
        </ScrollArea>,
      ),
    );
    const viewport = host.querySelector<HTMLElement>(".overscroll-contain");
    if (!viewport) throw new Error("Missing scroll viewport");
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 40 },
      scrollTop: { configurable: true, writable: true, value: 60 },
    });
    await act(() => viewport.dispatchEvent(new Event("scroll")));
    height = 160;
    await act(() =>
      root.render(
        <ScrollArea pinToEnd>
          <div>first line</div>
          <div>appended line</div>
        </ScrollArea>,
      ),
    );
    await act(() => resize?.());
    expect(viewport.scrollTop).toBe(viewport.scrollHeight);
  } finally {
    globalThis.ResizeObserver = originalResizeObserver;
    await act(() => root.unmount());
    host.remove();
  }
});

test("an unpinned scroll area ignores appended content", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(() =>
      root.render(
        <ScrollArea>
          <div>line</div>
        </ScrollArea>,
      ),
    );
    const viewport = host.querySelector<HTMLElement>(".overscroll-contain");
    if (!viewport) throw new Error("Missing scroll viewport");
    await act(() => viewport.dispatchEvent(new Event("scroll")));
    expect(viewport.scrollTop).toBe(0);
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});

test("timeline disclosure keeps expansion scoped to its session", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const nodes = [
    { kind: "prompt", id: "prompt", text: "inspect" },
    { kind: "tool", id: "tool", tool: "read", target: "file", payload: ["payload"] },
    { kind: "assistant", id: "answer", streaming: false, blocks: [{ kind: "p", text: "done" }] },
  ] as const;
  try {
    await act(() => root.render(<Timeline nodes={nodes} sessionId="session-a" />));
    const toggle = host.querySelector<HTMLButtonElement>("[data-tool-row] button");
    if (!toggle) throw new Error("Missing tool disclosure");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("payload");
    await act(() => root.render(<Timeline nodes={nodes} sessionId="session-b" />));
    expect(host.querySelector("[data-tool-row] button")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});
