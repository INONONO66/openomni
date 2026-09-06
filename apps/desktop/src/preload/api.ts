/** Contract exposed to the renderer via contextBridge. Leaf file: zero imports. */

/**
 * The gateway endpoint as the renderer receives it.
 *
 * Structurally identical to the main process's `GatewayEndpoint` and declared
 * separately on purpose: this file is the only module the renderer bundle and
 * the preload bundle share, and it must stay import-free so neither drags the
 * other's dependencies across the context boundary.
 */
export interface GatewayEndpoint {
  readonly url: string;
  readonly token?: string;
}

/**
 * The one IPC channel behind `window.desktop.gateway()`.
 *
 * `ipcMain.handle` and `ipcRenderer.invoke` are compiled into two different
 * bundles running in two different processes, so a mistyped channel is not a
 * type error — it is a promise that never settles. Both sides read the literal
 * from here.
 */
export const GATEWAY_CHANNEL = "openomni:gateway";

export interface DesktopApi {
  readonly versions: { readonly electron: string; readonly chrome: string; readonly node: string };
  /**
   * Where the gateway is, or `undefined` when this build has none.
   *
   * `undefined` is a real answer rather than an error: the renderer is also
   * rendered with no Electron behind it at all (the showcase, the screenshot
   * script), and it falls back to the mock transport in exactly that case.
   */
  readonly gateway: () => Promise<GatewayEndpoint | undefined>;
}

declare global {
  interface Window {
    readonly desktop: DesktopApi;
  }
}
