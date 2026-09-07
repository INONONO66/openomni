import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { STRIP } from "./fixture";

/**
 * The strip's history trio is ONE node for the window's life: collapsing and
 * re-opening the sidebar changes its `data-collapsed` attribute and nothing
 * else about its identity. Asserted on a live React root over a DOM, because
 * static markup cannot see a remount: the same HTML comes out of a node that
 * was replaced and one that was kept.
 *
 * The DOM is registered BEFORE `react-dom/client` loads: the client renderer
 * decides whether it can use a DOM at module evaluation.
 */
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, useEffect } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Sidebar } = await import("../src/sidebar");
const { TabStrip } = await import("../src/tab-strip");

afterAll(() => GlobalRegistrator.unregister());

/** Counts the trio's commits: a remount would run the mount effect again. */
let mounts = 0;
function MountProbe() {
  useEffect(() => {
    mounts += 1;
  }, []);
  return null;
}

function Frame({ open }: { readonly open: boolean }) {
  return (
    <Sidebar
      floating={false}
      onFloatingChange={() => undefined}
      onToggle={() => undefined}
      onWidthCommit={() => undefined}
      open={open}
      width={240}
    >
      <TabStrip
        createLabel={STRIP.createLabel}
        history={STRIP.history}
        onCreate={STRIP.onCreate}
        platform="darwin"
      />
      <MountProbe />
    </Sidebar>
  );
}

const trioOf = (container: Element) => {
  const node = container.querySelector('[data-ui="TabStrip.Trio"]');
  if (node === null) throw new Error("no trio");
  return node;
};

describe("the trio's identity", () => {
  test("Given the strip open, When the sidebar collapses and re-opens, Then the trio is the same node with only data-collapsed changed", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(() => root.render(<Frame open />));
    const trio = trioOf(container);
    expect(trio.getAttribute("data-collapsed")).toBe("false");
    trio.setAttribute("data-probe", "survives");
    const buttons = Array.from(trio.querySelectorAll("button"));
    expect(buttons).toHaveLength(3);

    await act(() => root.render(<Frame open={false} />));
    expect(trioOf(container)).toBe(trio);
    expect(trio.getAttribute("data-collapsed")).toBe("true");
    expect(Array.from(trio.querySelectorAll("button"))).toEqual(buttons);

    await act(() => root.render(<Frame open />));
    expect(trioOf(container)).toBe(trio);
    expect(trio.getAttribute("data-collapsed")).toBe("false");
    expect(trio.getAttribute("data-probe")).toBe("survives");
    expect(Array.from(trio.querySelectorAll("button"))).toEqual(buttons);
    expect(mounts).toBe(1);

    await act(() => root.unmount());
    container.remove();
  });
});
