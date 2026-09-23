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
  const closeWindow = () => undefined;
  expose({ gateway: "not callable", onShellCommand: () => () => undefined, closeWindow });
  expect(desktopBridge).toThrow();
  expose({ gateway: () => Promise.resolve(undefined), closeWindow });
  expect(desktopBridge).toThrow();
  expose({ gateway: () => Promise.resolve(undefined), onShellCommand: () => () => undefined });
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
  let closed = 0;
  const closeWindow = () => {
    closed += 1;
  };
  expose({ gateway, onShellCommand, closeWindow });
  const bridge = desktopBridge();
  if (!bridge) throw new Error("Missing bridge");
  bridge.closeWindow();
  expect(closed).toBe(1);
  expect(await bridge.gateway()).toEqual({ url: "ws://localhost" });
  const dispose = bridge.onShellCommand((command) => {
    delivered = command;
  });
  expect(delivered).toBe("new-tab");
  dispose();
  expect(delivered).toBe("disposed");
});
