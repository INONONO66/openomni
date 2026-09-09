import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Composer } from "../src/composer";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
afterAll(() => GlobalRegistrator.unregister());

test("mounted composer dispatches input, send, stop and approval actions", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const sent: string[] = [];
  const decisions: string[] = [];
  let value = "draft";
  const render = (props: Partial<Parameters<typeof Composer>[0]> = {}) =>
    act(() =>
      root.render(
        <Composer
          onApprove={(id) => decisions.push(`approve:${id}`)}
          onDeny={(id) => decisions.push(`deny:${id}`)}
          onSubmit={() => sent.push(value)}
          onValueChange={(next) => {
            value = next;
          }}
          pending={[]}
          value={value}
          {...props}
        />,
      ),
    );
  try {
    await render();
    const field = host.querySelector("textarea");
    if (!(field instanceof HTMLTextAreaElement)) throw new Error("Missing composer field");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) throw new Error("Missing textarea setter");
    await act(() => {
      setter.call(field, "edited");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    value = "edited";
    await render({ value });
    await act(() =>
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(sent).toEqual(["edited"]);
    await render({ sending: true, onStop: () => sent.push("stopped") });
    const stopButton = host.querySelector<HTMLButtonElement>('[data-ui="Composer.Stop"]');
    if (!stopButton) throw new Error("Missing stop button");
    await act(() => stopButton.click());
    expect(sent).toContain("stopped");
    await render({ pending: [{ toolId: "approval", summary: "run", reason: "test" }] });
    await act(() =>
      host
        .querySelector('[data-ui="ApprovalTray.Approve"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await act(() =>
      host
        .querySelector('[data-ui="ApprovalTray.Deny"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(decisions).toEqual(["approve:approval", "deny:approval"]);
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});
