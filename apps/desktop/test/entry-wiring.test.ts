import { expect, mock, test } from "bun:test";
import { GATEWAY_CHANNEL, type DesktopApi, type GatewayEndpoint } from "../src/preload/api";

test("desktop entries register IPC before window creation and resolve it before rendering", async () => {
  const ready = Promise.withResolvers<void>();
  const handlers = new Map<string, () => GatewayEndpoint>();
  const events = new Map<string, () => void>();
  const windows: WindowDouble[] = [];
  const loaded: string[] = [];
  const order: string[] = [];
  const rendered: object[] = [];
  const element = {};
  const globals = globalThis as { document?: object; desktop?: DesktopApi };
  const previousDocument = globals.document;
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
  globals.document = {
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
    windows.length = 0;
    events.get("activate")?.();
    expect(windows).toHaveLength(1);
    process.env.OPENOMNI_WS_URL = "ws://127.0.0.1:43211/ws";
    await import("../src/preload/index");
    expect(exposed).toBeDefined();
    expect(await exposed?.gateway()).toEqual({
      url: "ws://127.0.0.1:43210/ws",
      token: "entry-token",
    });
    order.length = 0;
    await import("../src/renderer/main");
    expect(order).toEqual(["root", "invoke", "render"]);
    expect(rendered).toHaveLength(1);
  } finally {
    if (previousDocument === undefined) delete globals.document;
    else globals.document = previousDocument;
    if (previousDesktop === undefined) delete globals.desktop;
    else globals.desktop = previousDesktop;
    for (const [index, key] of environment.entries()) {
      const value = previousEnvironment[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    mock.restore();
  }
}, 15_000);
