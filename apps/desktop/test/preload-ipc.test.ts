import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import {
  GATEWAY_CHANNEL,
  SHELL_COMMAND_CHANNEL,
  type DesktopApi,
  type ShellCommand,
} from "../src/preload/api";

type Wrapper = (event: { readonly senderId: number }, command: ShellCommand) => void;
const listeners = new Set<Wrapper>();
const registered: { channel: string; wrapper: Wrapper }[] = [];
const removed: { channel: string; wrapper: Wrapper }[] = [];
const invoked: string[] = [];
const exposed = new Map<string, DesktopApi>();
let gatewayResult: object | undefined = { url: "ws://localhost:3000/ws" };

mock.module("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: DesktopApi) => exposed.set(name, api),
  },
  ipcRenderer: {
    on: (channel: string, wrapper: Wrapper) => {
      registered.push({ channel, wrapper });
      listeners.add(wrapper);
    },
    removeListener: (channel: string, wrapper: Wrapper) => {
      removed.push({ channel, wrapper });
      listeners.delete(wrapper);
    },
    invoke: (channel: string) => {
      invoked.push(channel);
      return Promise.resolve(gatewayResult);
    },
  },
}));

// Query-suffixed so this file gets its own module instance: entry-wiring.test.ts
// evaluates the same preload against a different electron double first in a
// whole-suite run, and a cache hit would never call this file's exposeInMainWorld.
const ownInstance: string = "../src/preload/index?preload-ipc";
await import(ownInstance);
afterAll(() => mock.restore());
beforeEach(() => {
  gatewayResult = { url: "ws://localhost:3000/ws" };
  listeners.clear();
  registered.length = 0;
  removed.length = 0;
  invoked.length = 0;
});

test("gateway validates IPC replies and preserves absence", async () => {
  gatewayResult = { url: 3 };
  await expect(api().gateway()).rejects.toThrow();
  gatewayResult = { url: "ws://localhost", token: 9 };
  await expect(api().gateway()).rejects.toThrow();
  gatewayResult = undefined;
  expect(await api().gateway()).toBeUndefined();
  gatewayResult = { url: "ws://localhost", token: "secret" };
  expect(await api().gateway()).toEqual({ url: "ws://localhost", token: "secret" });
});

function api(): DesktopApi {
  const value = exposed.get("desktop");
  if (!value) throw new Error("Desktop bridge not exposed");
  return value;
}

function emit(command: ShellCommand): void {
  for (const wrapper of listeners) wrapper({ senderId: 27 }, command);
}

test("bridge exposes only versions, gateway, and value-only command subscription", async () => {
  expect(Object.keys(api()).sort()).toEqual(["gateway", "onShellCommand", "versions"]);
  expect(await api().gateway()).toEqual({ url: "ws://localhost:3000/ws" });
  expect(invoked).toEqual([GATEWAY_CHANNEL]);
  const received: ShellCommand[][] = [];
  const listener = (...args: ShellCommand[]) => received.push(args);
  const dispose = api().onShellCommand(listener);
  expect(registered).toHaveLength(1);
  expect(registered[0]?.channel).toBe(SHELL_COMMAND_CHANNEL);
  expect(registered[0]?.wrapper).not.toBe(listener);
  emit("close-tab");
  expect(received).toEqual([["close-tab"]]);
  dispose();
  expect(removed).toEqual(registered);
  expect(removed[0]?.wrapper).toBe(registered[0]?.wrapper);
  expect(listeners.size).toBe(0);
  emit("new-tab");
  expect(received).toEqual([["close-tab"]]);
});

test("independent subscriptions remove only their exact wrapper, including repeated listener identities", () => {
  const received: ShellCommand[] = [];
  const listener = (command: ShellCommand) => received.push(command);
  const first = api().onShellCommand(listener);
  const second = api().onShellCommand(listener);
  expect(listeners.size).toBe(2);
  expect(registered[0]?.wrapper).not.toBe(registered[1]?.wrapper);
  emit("next-tab");
  expect(received).toEqual(["next-tab", "next-tab"]);
  first();
  expect(listeners.size).toBe(1);
  emit("previous-tab");
  expect(received).toEqual(["next-tab", "next-tab", "previous-tab"]);
  second();
  expect(listeners.size).toBe(0);
});

test("dispose then remount leaves exactly one command delivery", () => {
  const received: ShellCommand[] = [];
  const listener = (command: ShellCommand) => received.push(command);
  api().onShellCommand(listener)();
  const dispose = api().onShellCommand(listener);
  expect(listeners.size).toBe(1);
  emit("reopen-tab");
  expect(received).toEqual(["reopen-tab"]);
  dispose();
});
