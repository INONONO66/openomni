import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, app, ipcMain, nativeTheme } from "electron";
import { GATEWAY_CHANNEL } from "../preload/api";
import { resolveGatewayEndpoint } from "./gateway-endpoint";
import {
  BOUNDS_WRITE_DELAY_MS,
  parseWindowBounds,
  serializeWindowBounds,
  WINDOW_MIN,
} from "./window-bounds";

/**
 * The environment is read ONCE, at startup.
 *
 * A window opened an hour later must not connect somewhere else because a
 * variable changed under the process, and re-reading per request would make the
 * endpoint a moving fact that no log line could pin down.
 */
const gateway = resolveGatewayEndpoint({
  OPENOMNI_WS_URL: process.env.OPENOMNI_WS_URL,
  OPENOMNI_WS_PORT: process.env.OPENOMNI_WS_PORT,
  OPENOMNI_WS_TOKEN: process.env.OPENOMNI_WS_TOKEN,
});

/** Same values as `--color-sunken` in @openomni/ui's two themes: no flash of the wrong shade before first paint. */
const BACKGROUND = { dark: "#0A0A0C", light: "#EFEFF0" } as const;

const boundsFile = () => join(app.getPath("userData"), "window-bounds.json");

function readBounds() {
  try {
    return parseWindowBounds(readFileSync(boundsFile(), "utf8"));
  } catch {
    return parseWindowBounds(null);
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    ...readBounds(),
    minWidth: WINDOW_MIN.width,
    minHeight: WINDOW_MIN.height,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
    // Custom chrome: the native title bar is hidden and the traffic lights sit
    // in the 42px tab strip (`--shell-top` / `--spacing-shell-strip` in
    // @openomni/ui), which drags the window via `-webkit-app-region` (see
    // `drag-region` / `no-drag`). `y: 15` centres the 12px lights in 42;
    // `x: 17` + the 52px cluster + 12 = the strip's 81px traffic safe zone.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 17, y: 15 },
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Off until first paint so a hidden window still renders; back on once
      // shown so a backgrounded window stops burning frames.
      backgroundThrottling: false,
    },
  });
  window.once("ready-to-show", () => {
    window.show();
    window.webContents.setBackgroundThrottling(true);
  });
  persistBounds(window);
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    attachRendererDebugging(window);
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
}

/** The last bounds win, once the window has been still for half a second. */
function persistBounds(window: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = () => {
    if (window.isDestroyed() || window.isMinimized() || window.isMaximized()) return;
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(boundsFile(), serializeWindowBounds(window.getBounds()));
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(write, BOUNDS_WRITE_DELAY_MS);
  };
  window.on("resize", schedule);
  window.on("move", schedule);
  window.on("close", () => {
    clearTimeout(timer);
    write();
  });
}

/**
 * Dev-only feedback loop: detached DevTools, and the renderer's console and
 * failure events mirrored to the main process's stdout with a `[renderer]`
 * prefix, so a renderer error shows up in the terminal that ran `dev`.
 */
function attachRendererDebugging(window: BrowserWindow): void {
  const { webContents } = window;
  webContents.openDevTools({ mode: "detach" });
  webContents.on("console-message", ({ level, message, sourceId, lineNumber }) => {
    console.log(`[renderer] ${level}: ${message} (${sourceId}:${lineNumber})`);
  });
  webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer] process gone: ${details.reason} (exit ${details.exitCode})`);
  });
  webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error(`[renderer] failed to load ${url}: ${description} (${code})`);
  });
}

app.whenReady().then(() => {
  // Registered before the first window exists: the renderer asks for the
  // endpoint on its first paint, and a handler installed inside `createWindow`
  // would be a race with it on the second window.
  ipcMain.handle(GATEWAY_CHANNEL, () => gateway);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
