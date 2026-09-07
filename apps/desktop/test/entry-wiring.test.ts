import { expect, jest, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoot, hydrateRoot } from "react-dom/client";

const realClient = { createRoot, hydrateRoot };
import { GATEWAY_CHANNEL, type DesktopApi, type GatewayEndpoint } from "../src/preload/api";

test("desktop entries register IPC before window creation and render without awaiting the gateway", async () => {
  const ready = Promise.withResolvers<void>();
  const userData = mkdtempSync(join(tmpdir(), "desktop-entry-"));
  const handlers = new Map<string, () => GatewayEndpoint>();
  const events = new Map<string, () => void>();
  const windows: WindowDouble[] = [];
  const loaded: string[] = [];
  const order: string[] = [];
  const rendered: object[] = [];
  const element = {};
  const globals = globalThis as { document?: object; window?: object; desktop?: DesktopApi };
  const previousDocument = globals.document;
  const previousWindow = globals.window;
  const previousDesktop = globals.desktop;
  const environment = ["OPENOMNI_WS_URL", "OPENOMNI_WS_TOKEN", "ELECTRON_RENDERER_URL"] as const;
  const previousEnvironment = environment.map((key) => process.env[key]);
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
    readonly listeners = new Map<string, () => void>();
    readonly webContents = {
      setBackgroundThrottling: mock((_enabled: boolean) => undefined),
      openDevTools: mock((_options: { mode: string }) => undefined),
      on: mock((_name: string, _callback: (...args: any[]) => void) => undefined),
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
    events.get("activate")?.();
    expect(windows).toHaveLength(1);
    windows.length = 0;
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173";
    events.get("activate")?.();
    expect(windows).toHaveLength(1);
    expect(loaded.at(-1)).toBe("http://localhost:5173");
    expect(windows[0]?.webContents.openDevTools).toHaveBeenCalledWith({ mode: "detach" });
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    const debug = windows[0]?.webContents.on.mock.calls;
    debug?.find(([name]) => name === "console-message")?.[1]({
      level: 1,
      message: "fixture",
      sourceId: "test",
      lineNumber: 2,
    });
    debug?.find(([name]) => name === "render-process-gone")?.[1](
      {},
      { reason: "crashed", exitCode: 1 },
    );
    debug?.find(([name]) => name === "did-fail-load")?.[1]({}, 3, "failed", "test");
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
    if (previousDocument === undefined) delete globals.document;
    else globals.document = previousDocument;
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
    if (previousDesktop === undefined) delete globals.desktop;
    else globals.desktop = previousDesktop;
    for (const [index, key] of environment.entries()) {
      const value = previousEnvironment[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.useRealTimers();
    rmSync(userData, { recursive: true, force: true });
    mock.restore();
    mock.module("react-dom/client", () => realClient);
  }
}, 15_000);
