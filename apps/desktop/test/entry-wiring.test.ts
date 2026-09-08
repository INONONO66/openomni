import { expect, jest, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoot, hydrateRoot } from "react-dom/client";

const realClient = { createRoot, hydrateRoot };
import { GATEWAY_CHANNEL, type DesktopApi, type GatewayEndpoint } from "../src/preload/api";

type Globals = { document?: object; window?: object; desktop?: DesktopApi };
const ENVIRONMENT = ["OPENOMNI_WS_URL", "OPENOMNI_WS_TOKEN", "ELECTRON_RENDERER_URL"] as const;

/** Snapshot the browser globals and gateway env the entries touch; returns the restorer. */
function snapshotHost(globals: Globals): () => void {
  const previous = { ...globals };
  const environment = ENVIRONMENT.map((key) => [key, process.env[key]] as const);
  const restore = <T extends object, K extends keyof T>(target: T, key: K, value: T[K]) => {
    if (value === undefined) delete target[key];
    else target[key] = value;
  };
  return () => {
    for (const key of ["document", "window", "desktop"] as const) restore(globals, key, previous[key]);
    for (const [key, value] of environment) restore(process.env, key, value);
  };
}

interface DebugEvents {
  "console-message": [{ level: number; message: string; sourceId: string; lineNumber: number }];
  "render-process-gone": [object, { reason: string; exitCode: number }];
  "did-fail-load": [object, number, string, string];
}
type DebugListeners = { [K in keyof DebugEvents]?: (...args: DebugEvents[K]) => void };
/** Fire the webContents debug listener registered under `name` with `args`. */
function fireDebug<K extends keyof DebugEvents>(listeners: DebugListeners | undefined, name: K, ...args: DebugEvents[K]): void {
  const listener = listeners?.[name];
  expect(listener).toBeDefined();
  listener?.(...args);
}

test("desktop entries register IPC before window creation and render without awaiting the gateway", async () => {
  const ready = Promise.withResolvers<void>();
  const userData = mkdtempSync(join(tmpdir(), "desktop-entry-"));
  const handlers = new Map<string, () => GatewayEndpoint>();
  const events = new Map<string, () => void>();
  const windows: WindowDouble[] = [];
  const menus: number[] = [];
  const loaded: string[] = [];
  const order: string[] = [];
  const rendered: object[] = [];
  const element = {};
  const globals = globalThis as Globals;
  const restoreHost = snapshotHost(globals);
  let exposed: DesktopApi | undefined;

  class WindowDouble {
    constructor(
      readonly options: {
        titleBarStyle: string;
        webPreferences: { contextIsolation: boolean; sandbox: boolean; nodeIntegration: boolean };
      },
    ) {
      expect(handlers.has(GATEWAY_CHANNEL)).toBe(true);
      windows.push(this);
    }
    readonly id = windows.length;
    readonly listeners = new Map<string, () => void>();
    readonly debug: DebugListeners = {};
    readonly webContents = {
      setBackgroundThrottling: mock((_enabled: boolean) => undefined),
      openDevTools: mock((_options: { mode: string }) => undefined),
      on: <K extends keyof DebugEvents>(name: K, callback: DebugListeners[K]) => {
        this.debug[name] = callback;
      },
    };
    readonly once = (name: string, callback: () => void) => this.listeners.set(name, callback);
    readonly on = (name: string, callback: () => void) => this.listeners.set(name, callback);
    readonly show = mock(() => undefined);
    readonly isDestroyed = () => false;
    readonly isMinimized = () => false;
    readonly isMaximized = () => false;
    readonly getBounds = () => ({ x: 30, y: 40, width: 1200, height: 800 });
    loadURL(url: string): Promise<void> {
      loaded.push(url);
      return Promise.resolve();
    }
    static getFocusedWindow(): WindowDouble | null {
      return null;
    }
    loadFile(path: string): Promise<void> {
      loaded.push(path);
      ready.resolve();
      return Promise.resolve();
    }
    static getAllWindows(): WindowDouble[] {
      return windows;
    }
  }
  mock.module("electron", () => ({
    BrowserWindow: WindowDouble,
    app: {
      whenReady: () => Promise.resolve(),
      getPath: () => userData,
      on: (name: string, callback: () => void) => {
        events.set(name, callback);
      },
      quit: () => {
        order.push("quit");
      },
    },
    ipcMain: {
      handle: (channel: string, callback: () => GatewayEndpoint) => {
        handlers.set(channel, callback);
      },
    },
    nativeTheme: { shouldUseDarkColors: true },
    Menu: {
      buildFromTemplate: (template: object[]) => {
        order.push(`menu:${template.length}`);
        return { template };
      },
      setApplicationMenu: (menu: { template: object[] }) => {
        menus.push(menu.template.length);
      },
    },
    contextBridge: {
      exposeInMainWorld: (name: string, api: DesktopApi) => {
        expect(name).toBe("desktop");
        exposed = api;
        globals.desktop = api;
      },
    },
    ipcRenderer: {
      invoke: (channel: string): Promise<GatewayEndpoint | undefined> => {
        order.push("invoke");
        const handler = handlers.get(channel);
        expect(handler).toBeDefined();
        return Promise.resolve(handler?.());
      },
    },
  }));
  mock.module("react-dom/client", () => ({
    createRoot: (container: object) => {
      expect(container).toBe(element);
      order.push("root");
      return {
        render: (node: object) => {
          rendered.push(node);
          order.push("render");
        },
      };
    },
  }));
  const listeners = {
    addEventListener: (_name: string) => undefined,
    removeEventListener: (_name: string) => undefined,
  };
  globals.window = { ...listeners, localStorage: {} };
  globals.document = {
    ...listeners,
    documentElement: { dataset: {} },
    getElementById: (id: string) => {
      expect(id).toBe("root");
      return element;
    },
  };
  process.env.OPENOMNI_WS_URL = "ws://127.0.0.1:43210/ws";
  process.env.OPENOMNI_WS_TOKEN = "entry-token";
  delete process.env.ELECTRON_RENDERER_URL;
  try {
    await import("../src/main/index");
    await ready.promise;
    expect(windows).toHaveLength(1);
    expect(windows[0]?.options.webPreferences).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    });
    expect(loaded[0]?.endsWith("/renderer/index.html")).toBe(true);
    const first = windows[0];
    expect(first).toBeDefined();
    first?.listeners.get("ready-to-show")?.();
    expect(first?.show).toHaveBeenCalledTimes(1);
    expect(first?.webContents.setBackgroundThrottling).toHaveBeenCalledWith(true);
    jest.useFakeTimers();
    first?.listeners.get("move")?.();
    first?.listeners.get("resize")?.();
    jest.runAllTimers();
    expect(JSON.parse(readFileSync(join(userData, "window-bounds.json"), "utf8"))).toMatchObject({
      width: 1200,
      height: 800,
    });
    first?.listeners.get("close")?.();
    jest.useRealTimers();
    expect(menus).toHaveLength(1);
    expect(menus[0]).toBeGreaterThan(0);
    events.get("activate")?.();
    expect(windows).toHaveLength(1);
    windows[0]?.listeners.get("closed")?.();
    windows.length = 0;
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173";
    events.get("activate")?.();
    expect(windows).toHaveLength(1);
    expect(loaded.at(-1)).toBe("http://localhost:5173");
    expect(windows[0]?.webContents.openDevTools).toHaveBeenCalledWith({ mode: "detach" });
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    const debug = windows[0]?.debug;
    fireDebug(debug, "console-message", { level: 1, message: "fixture", sourceId: "test", lineNumber: 2 });
    fireDebug(debug, "render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    fireDebug(debug, "did-fail-load", {}, 3, "failed", "test");
    expect(log).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(2);
    log.mockRestore();
    error.mockRestore();
    process.env.OPENOMNI_WS_URL = "ws://127.0.0.1:43211/ws";
    await import("../src/preload/index");
    expect(exposed).toBeDefined();
    expect(await exposed?.gateway()).toEqual({
      url: "ws://127.0.0.1:43210/ws",
      token: "entry-token",
    });
    order.length = 0;
    await import("../src/renderer/main");
    expect(order).toEqual(["root", "render"]);
    expect(rendered).toHaveLength(1);
  } finally {
    restoreHost();
    jest.useRealTimers();
    rmSync(userData, { recursive: true, force: true });
    mock.restore();
    mock.module("react-dom/client", () => realClient);
  }
}, 15_000);
