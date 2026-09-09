import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ScrollArea } from "../src/primitives/scroll-area";
import { Timeline } from "../src/timeline/timeline";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
afterAll(() => GlobalRegistrator.unregister());

test("scroll area pins content appended after opening to the end", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const originalResizeObserver = globalThis.ResizeObserver;
  let resize: (() => void) | undefined;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      resize = callback;
    }
    observe() {
      // The test invokes the captured callback after appending content.
    }
    disconnect() {
      // No observer resources exist in this deterministic test double.
    }
  } as unknown as typeof ResizeObserver;
  let height = 100;
  try {
    await act(() => root.render(<ScrollArea pinToEnd><div>first line</div></ScrollArea>));
    const viewport = host.querySelector<HTMLElement>(".overscroll-contain");
    if (!viewport) throw new Error("Missing scroll viewport");
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 40 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    height = 160;
    await act(() => root.render(<ScrollArea pinToEnd><div>first line</div><div>appended line</div></ScrollArea>));
    await act(() => resize?.());
    expect(viewport.scrollTop).toBe(viewport.scrollHeight);
  } finally {
    globalThis.ResizeObserver = originalResizeObserver;
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
    const toggle = host.querySelector<HTMLButtonElement>('[data-tool-row] button');
    if (!toggle) throw new Error("Missing tool disclosure");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("payload");
    await act(() => root.render(<Timeline nodes={nodes} sessionId="session-b" />));
    expect(host.querySelector('[data-tool-row] button')?.getAttribute("aria-expanded")).toBe("false");
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});
