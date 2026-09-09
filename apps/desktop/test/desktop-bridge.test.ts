import { afterEach, expect, test } from "bun:test";
import { desktopBridge } from "../src/renderer/state/desktop-bridge";

const target = typeof window === "undefined" ? globalThis : window;
const original = Object.getOwnPropertyDescriptor(target, "desktop");
afterEach(() => {
  if (original) Object.defineProperty(target, "desktop", original);
  else Reflect.deleteProperty(target, "desktop");
});

function expose(value: object | undefined) {
  Object.defineProperty(target, "desktop", { configurable: true, value });
}

test("browser preview has no desktop bridge", () => {
  expose(undefined);
  expect(desktopBridge()).toBeUndefined();
});

test("malformed bridge methods fail at lookup", () => {
  expose({ gateway: "not callable", onShellCommand: () => () => undefined });
  expect(desktopBridge).toThrow();
  expose({ gateway: () => Promise.resolve(undefined) });
  expect(desktopBridge).toThrow();
});

test("bridge validates gateway and preserves command delivery and disposal", async () => {
  let delivered = "";
  const gateway = () => Promise.resolve({ url: "ws://localhost" });
  const onShellCommand = (listener: (command: "new-tab") => void) => {
    listener("new-tab");
    return () => {
      delivered = "disposed";
    };
  };
  expose({ gateway, onShellCommand });
  const bridge = desktopBridge();
  if (!bridge) throw new Error("Missing bridge");
  expect(await bridge.gateway()).toEqual({ url: "ws://localhost" });
  const dispose = bridge.onShellCommand((command) => {
    delivered = command;
  });
  expect(delivered).toBe("new-tab");
  dispose();
  expect(delivered).toBe("disposed");
});
