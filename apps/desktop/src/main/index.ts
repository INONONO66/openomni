import { join } from "node:path";
import { BrowserWindow, app, ipcMain } from "electron";
import { GATEWAY_CHANNEL } from "../preload/api";
import { resolveGatewayEndpoint } from "./gateway-endpoint";

/**
 * The environment is read ONCE, at startup.
 *
 * A window opened an hour later must not connect somewhere else because a
 * variable changed under the process, and re-reading per request would make the
 * endpoint a moving fact that no log line could pin down.
 */
const gateway = resolveGatewayEndpoint(process.env);

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
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
