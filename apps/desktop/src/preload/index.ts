import { contextBridge, ipcRenderer } from "electron";
import { GATEWAY_CHANNEL, type DesktopApi, type GatewayEndpoint } from "./api";

const api: DesktopApi = {
  versions: {
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
  },
  /**
   * One `invoke`, no cache. The main process answers from an environment that
   * was read at boot, so this is cheap, and caching it here would put a second
   * copy of the answer in the one process that is not allowed to have opinions
   * about it.
   */
  gateway: () => ipcRenderer.invoke(GATEWAY_CHANNEL) as Promise<GatewayEndpoint | undefined>,
};

contextBridge.exposeInMainWorld("desktop", api);
