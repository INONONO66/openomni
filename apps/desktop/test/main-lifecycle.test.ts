import { expect, jest, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MenuItemConstructorOptions } from "electron";
import { BOUNDS_WRITE_DELAY_MS, parseWindowBounds } from "../src/main/window-bounds";
import type { GatewayEndpoint } from "../src/preload/api";
import { GATEWAY_CHANNEL, SHELL_COMMAND_CHANNEL, type ShellCommand } from "../src/preload/api";

import { flatten } from "./helpers/menu";

test.each([
  false,
  true,
])("main window lifecycle, owner routing and persistence (development=%s)", async (development) => {
  const directory = mkdtempSync(join(tmpdir(), "openomni-tabs-main-"));
  const file = join(directory, "window-bounds.json");
  const ready = Promise.withResolvers<void>();
  const events = new EventEmitter();
  const handlers = new Map<string, () => GatewayEndpoint>();
  const windows: WindowDouble[] = [];
  const switches: string[][] = [];
  const loaded: string[] = [];
  const sent: { id: number; channel: string; command: ShellCommand }[] = [];
  const throttle: boolean[] = [];
  let focused: WindowDouble | null = null;
  let menu: MenuItemConstructorOptions[] = [];
  let quits = 0;
  let shown = 0;
  let debugOpened = 0;
  const previousUrl = process.env.ELECTRON_RENDERER_URL;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  const error = spyOn(console, "error").mockImplementation(() => undefined);

  class WindowDouble extends EventEmitter {
    readonly id = windows.length + 1;
    readonly webContents = Object.assign(new EventEmitter(), {
      id: this.id * 10,
      devToolsWebContents: { id: this.id * 10 + 1 },
      isDestroyed: () => this.destroyedContents,
      send: (channel: string, command: ShellCommand) =>
        sent.push({ id: this.id, channel, command }),
      setBackgroundThrottling: (enabled: boolean) => throttle.push(enabled),
      openDevTools: (options: { mode: string }) => {
        expect(options.mode).toBe("detach");
        debugOpened += 1;
      },
    });
    destroyed = false;
    destroyedContents = false;
    minimized = false;
    maximized = false;
    bounds = { x: 10, y: 20, width: 1000, height: 700 };
    constructor(
      readonly options: {
        width: number;
        height: number;
        show: boolean;
        webPreferences: { backgroundThrottling: boolean };
      },
    ) {
      super();
      expect(handlers.has(GATEWAY_CHANNEL)).toBe(true);
      expect(menu.length).toBeGreaterThan(0);
      windows.push(this);
    }
    isDestroyed = () => this.destroyed;
    isMinimized = () => this.minimized;
    isMaximized = () => this.maximized;
    getBounds = () => this.bounds;
    show = () => {
      shown += 1;
    };
    loadFile = (path: string) => {
      loaded.push(path);
      ready.resolve();
      return Promise.resolve();
    };
    loadURL = (url: string) => {
      loaded.push(url);
      ready.resolve();
      return Promise.resolve();
    };
    static getFocusedWindow() {
      return focused;
    }
  }
  mock.module("electron", () => ({
    BrowserWindow: WindowDouble,
    app: {
      whenReady: () => Promise.resolve(),
      getPath: () => directory,
      on: events.on.bind(events),
      quit: () => {
        quits += 1;
      },
      commandLine: { appendSwitch: (...args: string[]) => switches.push(args) },
    },
    ipcMain: {
      handle: (channel: string, handler: () => GatewayEndpoint) => handlers.set(channel, handler),
    },
    nativeTheme: { shouldUseDarkColors: !development },
    Menu: {
      buildFromTemplate: (template: MenuItemConstructorOptions[]) => template,
      setApplicationMenu: (template: MenuItemConstructorOptions[]) => {
        menu = template;
      },
    },
  }));
  if (development) process.env.ELECTRON_RENDERER_URL = "http://localhost:5173";
  else delete process.env.ELECTRON_RENDERER_URL;
  Object.defineProperty(process, "platform", {
    value: development ? "linux" : "darwin",
    configurable: true,
  });
  try {
    // Entry modules are cached across test files; each double needs its own evaluation.
    const ownInstance: string = `../src/main/index?main-lifecycle-${development}`;
    await import(ownInstance);
    await ready.promise;
    expect(windows).toHaveLength(1);
    const first = windows[0];
    if (!first) throw new Error("Missing window");
    expect(first.options).toMatchObject({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: { backgroundThrottling: false },
    });
    expect(switches).toEqual(development ? [["remote-debugging-port", "9333"]] : []);
    expect(debugOpened).toBe(development ? 1 : 0);
    expect(
      development
        ? loaded[0] === process.env.ELECTRON_RENDERER_URL
        : loaded[0]?.endsWith("/renderer/index.html"),
    ).toBe(true);
    first.emit("ready-to-show");
    expect(shown).toBe(1);
    expect(throttle).toEqual([true]);
    const close = flatten(menu).find((item) => item.id === "close-tab");
    if (!close?.click) throw new Error("Missing close-tab command");
    const closeClick = close.click;
    const dispatch = (): void => {
      Reflect.apply(closeClick, undefined, []);
    };
    dispatch();
    expect(sent).toEqual([]);
    first.emit("focus");
    dispatch();
    expect(sent).toEqual([{ id: first.id, channel: SHELL_COMMAND_CHANNEL, command: "close-tab" }]);
    focused = first;
    dispatch();
    expect(sent).toHaveLength(2);
    focused = null;
    first.webContents.emit("devtools-focused");
    dispatch();
    expect(sent).toHaveLength(3);
    first.destroyedContents = true;
    dispatch();
    expect(sent).toHaveLength(3);
    first.destroyedContents = false;
    events.emit("activate");
    expect(windows).toHaveLength(1);

    jest.useFakeTimers();
    first.emit("resize");
    jest.advanceTimersByTime(BOUNDS_WRITE_DELAY_MS - 1);
    expect(existsSync(file)).toBe(false);
    first.bounds = { x: 30, y: 40, width: 1100, height: 750 };
    first.emit("move");
    jest.advanceTimersByTime(BOUNDS_WRITE_DELAY_MS - 1);
    expect(existsSync(file)).toBe(false);
    jest.advanceTimersByTime(1);
    expect(parseWindowBounds(readFileSync(file, "utf8"))).toEqual(first.bounds);
    const saved = readFileSync(file, "utf8");
    first.bounds = { ...first.bounds, width: 1200 };
    for (const state of ["minimized", "maximized", "destroyed"] as const) {
      first[state] = true;
      first.emit("close");
      expect(readFileSync(file, "utf8")).toBe(saved);
      first[state] = false;
    }
    first.emit("move");
    first.emit("close");
    expect(parseWindowBounds(readFileSync(file, "utf8"))).toEqual(first.bounds);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
    if (development) {
      first.webContents.emit("console-message", {
        level: 2,
        message: "debug-sentinel",
        sourceId: "renderer.js",
        lineNumber: 17,
      });
      first.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 3 });
      first.webContents.emit("did-fail-load", {}, -2, "load-sentinel", "http://localhost:5173");
      expect(log).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(2);
    }
    first.emit("closed");
    dispatch();
    expect(sent).toHaveLength(3);
    events.emit("activate");
    expect(windows).toHaveLength(2);
    expect(windows[1]?.options).toMatchObject(first.bounds);
    events.emit("window-all-closed");
    expect(quits).toBe(development ? 1 : 0);
  } finally {
    jest.useRealTimers();
    log.mockRestore();
    error.mockRestore();
    if (previousUrl === undefined) delete process.env.ELECTRON_RENDERER_URL;
    else process.env.ELECTRON_RENDERER_URL = previousUrl;
    if (platform) Object.defineProperty(process, "platform", platform);
    mock.restore();
    rmSync(directory, { recursive: true, force: true });
  }
});
